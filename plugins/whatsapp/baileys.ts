/**
 * Linked-device transport — no WhatsApp Business API involved.
 *
 * Registers as an additional device on an ordinary WhatsApp account, the same
 * mechanism WhatsApp Web and WhatsApp Desktop use: you scan a QR code once and
 * the session persists. Works with any number already on WhatsApp, personal or
 * Business app. No Meta app, no business verification, no dedicated number,
 * and none of the business platform's restrictions — no 24-hour window, no
 * message templates, groups and voice notes arrive natively.
 *
 * The trade: this speaks the WhatsApp Web protocol through an unofficial
 * library, which WhatsApp's terms do not permit, and accounts can be banned.
 * Documented bans cluster around bulk sending and status spam rather than
 * low-volume personal use, and this transport deliberately keeps the traffic
 * shape conservative (see pacing below), but the risk is real. Prefer a number
 * you could stand to lose.
 */

import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { basename, join } from 'path'
import QRCode from 'qrcode'
import type { InboundMessage, Transport, TransportCapabilities, TransportHandlers } from './transport.ts'
import { normalizeWaId } from './transport.ts'

export type BaileysConfig = {
  authDir: string
  inboxDir: string
  /** Where the pairing QR is written for /whatsapp:link to display. */
  qrPath: string
  /** Minimum gap between outbound sends, ms. Keeps the traffic shape human. */
  minSendGapMs: number
}

/** wa_id digits -> WhatsApp JID. */
function toJid(waId: string): string {
  return `${normalizeWaId(waId)}@s.whatsapp.net`
}

/** JID -> wa_id digits. Handles @s.whatsapp.net, @lid and device suffixes. */
function fromJid(jid: string): string {
  return normalizeWaId(jid.split('@')[0].split(':')[0])
}

export class BaileysTransport implements Transport {
  readonly name = 'linked-device'
  // A linked device is just a client: none of the business platform's sending
  // restrictions exist, and it cannot render interactive reply buttons.
  readonly capabilities: TransportCapabilities = {
    serviceWindow: false,
    templates: false,
    buttons: false,
  }

  private cfg: BaileysConfig
  private sock: WASocket | undefined
  private handlers: TransportHandlers | undefined
  private ownId = ''
  private stopping = false
  private lastSendAt = 0
  private saveCreds: (() => Promise<void>) | undefined

  /**
   * Message ids this process sent. Outbound messages echo back through
   * messages.upsert with fromMe set, and in a self-chat they are
   * indistinguishable from the user's own messages by jid alone — without this
   * the assistant answers itself forever.
   */
  private ownSends = new Set<string>()
  private ownSendOrder: string[] = []

  /** Recent inbound messages, so downloadMedia can re-derive the payload. */
  private recent = new Map<string, WAMessage>()
  private recentOrder: string[] = []

  constructor(cfg: BaileysConfig) {
    this.cfg = cfg
  }

  private status(line: string): void {
    this.handlers?.onStatus(line)
  }

  private remember(id: string, msg: WAMessage): void {
    this.recent.set(id, msg)
    this.recentOrder.push(id)
    if (this.recentOrder.length > 200) {
      const old = this.recentOrder.shift()!
      this.recent.delete(old)
    }
  }

  private noteOwnSend(id: string | null | undefined): void {
    if (!id) return
    this.ownSends.add(id)
    this.ownSendOrder.push(id)
    if (this.ownSendOrder.length > 500) {
      const old = this.ownSendOrder.shift()!
      this.ownSends.delete(old)
    }
  }

  /**
   * Space outbound sends. Bursts are the single clearest signal of automation,
   * and a chat assistant has no reason to send faster than a person types.
   */
  private async pace(): Promise<void> {
    const wait = this.lastSendAt + this.cfg.minSendGapMs - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    this.lastSendAt = Date.now()
  }

  private requireSock(): WASocket {
    if (!this.sock) throw new Error('not connected to WhatsApp yet')
    if (!this.ownId) throw new Error('WhatsApp link not established — run /whatsapp:link and scan the QR code')
    return this.sock
  }

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers
    await this.connect()
  }

  private async connect(): Promise<void> {
    mkdirSync(this.cfg.authDir, { recursive: true, mode: 0o700 })
    const { state, saveCreds } = await useMultiFileAuthState(this.cfg.authDir)
    this.saveCreds = saveCreds

    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as any }))

    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      // stdout is the MCP transport. Anything written there corrupts the
      // protocol stream, so the QR goes to a file instead (see below).
      printQRInTerminal: false,
      // Presenting as a desktop client matches what a linked device is.
      browser: ['Claude Code', 'Desktop', '1.0.0'],
      // Don't advertise as online: it would mark the user's own phone presence
      // as active and stop their phone notifications.
      markOnlineOnConnect: false,
      // The assistant only needs messages from now on, and a full history sync
      // is a large, conspicuous download.
      syncFullHistory: false,
      getMessage: async key => this.recent.get(key.id ?? '')?.message ?? undefined,
    })
    this.sock = sock

    sock.ev.on('creds.update', () => { void saveCreds() })

    sock.ev.on('connection.update', update => {
      const { connection, lastDisconnect, qr } = update

      if (qr) void this.writeQr(qr)

      if (connection === 'open') {
        this.ownId = jidNormalizedUser(sock.user?.id ?? '')
        rmSync(this.cfg.qrPath, { force: true })
        rmSync(`${this.cfg.qrPath}.png`, { force: true })
        this.status(`linked as ${fromJid(this.ownId)} — ready`)
        return
      }

      if (connection === 'close') {
        if (this.stopping) return
        // Boom-shaped error from the socket; typed locally to avoid depending on
        // @hapi/boom directly just to read one status code.
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          // Credentials are dead; reconnecting in a loop would spin forever.
          this.status('logged out on the phone — clearing credentials, run /whatsapp:link to re-pair')
          try { rmSync(this.cfg.authDir, { recursive: true, force: true }) } catch {}
          this.ownId = ''
          return
        }
        this.status(`connection closed (${code ?? 'unknown'}), reconnecting`)
        setTimeout(() => { if (!this.stopping) void this.connect().catch(e => this.status(`reconnect failed: ${e}`)) }, 3000)
      }
    })

    sock.ev.on('messages.upsert', ev => {
      if (ev.type !== 'notify') return // 'append' is history backfill
      for (const msg of ev.messages) void this.handleRaw(msg)
    })
  }

  private async writeQr(qr: string): Promise<void> {
    try {
      const ascii = await QRCode.toString(qr, { type: 'terminal', small: true })
      writeFileSync(this.cfg.qrPath, ascii)
      await QRCode.toFile(`${this.cfg.qrPath}.png`, qr, { width: 512 })
      this.status(`pairing QR written to ${this.cfg.qrPath} — run /whatsapp:link to display it`)
    } catch (err) {
      this.status(`could not render QR: ${err}`)
    }
  }

  private async handleRaw(msg: WAMessage): Promise<void> {
    const id = msg.key?.id
    const remoteJid = msg.key?.remoteJid
    if (!id || !remoteJid || !msg.message) return

    // Groups are out of scope: a group member is not someone the user paired,
    // and permission relay to a group would let anyone in it approve tool use.
    if (isJidGroup(remoteJid)) return
    if (remoteJid === 'status@broadcast') return

    const selfChat = this.ownId !== '' && jidNormalizedUser(remoteJid) === this.ownId

    if (msg.key.fromMe) {
      // Our own outbound, echoed back.
      if (this.ownSends.has(id)) return
      // In a self-chat, the user's own messages also arrive with fromMe set —
      // that is the user talking to their assistant, so it must get through.
      // Anywhere else, fromMe means the user messaging someone else from their
      // phone, which is none of the assistant's business.
      if (!selfChat) return
    }

    this.remember(id, msg)

    const type = getContentType(msg.message) ?? 'unknown'
    const m = msg.message
    const ts = Number(msg.messageTimestamp ?? 0) * 1000

    let text = ''
    let mediaRef: string | undefined
    let mime: string | undefined
    let fileName: string | undefined
    let buttonId: string | undefined

    switch (type) {
      case 'conversation':
        text = m.conversation ?? ''
        break
      case 'extendedTextMessage':
        text = m.extendedTextMessage?.text ?? ''
        break
      case 'imageMessage':
        text = m.imageMessage?.caption || '(image)'
        mediaRef = id; mime = m.imageMessage?.mimetype ?? undefined
        break
      case 'videoMessage':
        text = m.videoMessage?.caption || '(video)'
        mediaRef = id; mime = m.videoMessage?.mimetype ?? undefined
        break
      case 'audioMessage':
        text = m.audioMessage?.ptt ? '(voice note)' : '(audio)'
        mediaRef = id; mime = m.audioMessage?.mimetype ?? undefined
        break
      case 'documentMessage':
      case 'documentWithCaptionMessage': {
        const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage
        fileName = doc?.fileName ?? undefined
        text = doc?.caption || `(document: ${fileName ?? 'file'})`
        mediaRef = id; mime = doc?.mimetype ?? undefined
        break
      }
      case 'stickerMessage':
        text = '(sticker)'
        mediaRef = id; mime = m.stickerMessage?.mimetype ?? undefined
        break
      case 'locationMessage': {
        const l = m.locationMessage
        text = `(location: ${l?.degreesLatitude},${l?.degreesLongitude}${l?.name ? ` — ${l.name}` : ''})`
        break
      }
      case 'buttonsResponseMessage':
        buttonId = m.buttonsResponseMessage?.selectedButtonId ?? undefined
        text = m.buttonsResponseMessage?.selectedDisplayText ?? '(button)'
        break
      case 'templateButtonReplyMessage':
        buttonId = m.templateButtonReplyMessage?.selectedId ?? undefined
        text = m.templateButtonReplyMessage?.selectedDisplayText ?? '(button)'
        break
      case 'reactionMessage':
        return // reactions are noise for an assistant
      case 'protocolMessage':
      case 'senderKeyDistributionMessage':
        return
      default:
        text = `(${type})`
    }

    if (!text && !mediaRef) return

    const inbound: InboundMessage = {
      senderId: fromJid(remoteJid),
      messageId: id,
      timestamp: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
      text,
      profileName: msg.pushName ?? undefined,
      msgType: type,
      ...(mediaRef ? { mediaRef } : {}),
      ...(mime ? { mime } : {}),
      ...(fileName ? { fileName } : {}),
      ...(buttonId ? { buttonId } : {}),
    }

    await this.handlers!.onMessage(inbound)
  }

  async sendText(to: string, text: string): Promise<string> {
    const sock = this.requireSock()
    await this.pace()
    const sent = await sock.sendMessage(toJid(to), { text })
    this.noteOwnSend(sent?.key?.id)
    return sent?.key?.id ?? '(no id)'
  }

  async sendFile(to: string, path: string, caption?: string): Promise<string> {
    const sock = this.requireSock()
    await this.pace()
    const ext = (path.match(/\.[^.\/]+$/)?.[0] ?? '').toLowerCase()
    const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)
    const jid = toJid(to)
    const sent = isImage
      ? await sock.sendMessage(jid, { image: { url: path }, ...(caption ? { caption } : {}) })
      : await sock.sendMessage(jid, {
          document: { url: path },
          fileName: basename(path),
          mimetype: 'application/octet-stream',
          ...(caption ? { caption } : {}),
        })
    this.noteOwnSend(sent?.key?.id)
    return sent?.key?.id ?? '(no id)'
  }

  async downloadMedia(mediaRef: string): Promise<string> {
    const msg = this.recent.get(mediaRef)
    if (!msg) {
      throw new Error(
        `message ${mediaRef} is no longer cached, so its media cannot be fetched. ` +
        `Ask the sender to resend it.`,
      )
    }
    const buf = await downloadMediaMessage(msg, 'buffer', {}) as Buffer

    const type = getContentType(msg.message!) ?? ''
    const node = (msg.message as any)?.[type]
    const mime: string = node?.mimetype ?? ''
    const subtype = mime.split(';')[0].split('/')[1] ?? 'bin'
    const ext = subtype.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const safeId = mediaRef.replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'

    mkdirSync(this.cfg.inboxDir, { recursive: true })
    const path = join(this.cfg.inboxDir, `${Date.now()}-${safeId}.${ext}`)
    writeFileSync(path, buf)
    return path
  }

  async markRead(messageId: string, senderId: string): Promise<void> {
    try {
      const msg = this.recent.get(messageId)
      if (!msg?.key) return
      await this.sock?.readMessages([msg.key])
    } catch {
      // Cosmetic. Never let it break message handling.
    }
  }

  /**
   * The linked account messaging itself. WhatsApp's "Message yourself" chat is
   * the natural way to reach your own assistant, so it skips pairing — there is
   * nobody else to authenticate.
   */
  isSelf(senderId: string): boolean {
    return this.ownId !== '' && normalizeWaId(senderId) === fromJid(this.ownId)
  }

  /** True once the QR has been scanned and the socket is authenticated. */
  isLinked(): boolean {
    return this.ownId !== ''
  }

  /** wa_id of the linked account, for the self-chat hint in /whatsapp:link. */
  linkedAs(): string {
    return this.ownId ? fromJid(this.ownId) : ''
  }

  stop(): void {
    this.stopping = true
    try { this.sock?.end(undefined) } catch {}
  }
}
