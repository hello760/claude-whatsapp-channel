/**
 * Cloud API transport — the official WhatsApp Business Platform.
 *
 * Inbound is a webhook: Meta POSTs to a public HTTPS URL, so this listens on
 * localhost behind a tunnel or reverse proxy. Because that endpoint is
 * reachable from the open internet, X-Hub-Signature-256 verification is
 * mandatory here, not optional — it is the only thing between the web and text
 * injected into the session.
 *
 * Requires a phone number dedicated to the API: registering a number here
 * removes it from regular WhatsApp. If that is not acceptable, use the linked
 * device transport instead.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { InboundMessage, Transport, TransportCapabilities, TransportHandlers } from './transport.ts'
import { normalizeWaId } from './transport.ts'

export type CloudConfig = {
  accessToken: string
  phoneNumberId: string
  appSecret: string
  verifyToken: string
  apiVersion: string
  graphBase: string
  port: number
  bind: string
  inboxDir: string
}

type RawMessage = {
  from?: string
  id?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
  audio?: { voice?: boolean }
  document?: { filename?: string }
  location?: { latitude?: number; longitude?: number; name?: string }
  interactive?: { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } }
  button?: { payload?: string; text?: string }
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

export class CloudTransport implements Transport {
  readonly name = 'cloud'
  // The business platform's rules all apply here.
  readonly capabilities: TransportCapabilities = {
    serviceWindow: true,
    templates: true,
    buttons: true,
  }

  private cfg: CloudConfig
  private server: ReturnType<typeof Bun.serve> | undefined

  constructor(cfg: CloudConfig) {
    this.cfg = cfg
  }

  private get graph(): string {
    return `${this.cfg.graphBase}/${this.cfg.apiVersion}`
  }

  private get messagesUrl(): string {
    return `${this.graph}/${this.cfg.phoneNumberId}/messages`
  }

  private get auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.accessToken}` }
  }

  private async post(body: unknown): Promise<any> {
    const res = await fetch(this.messagesUrl, {
      method: 'POST',
      headers: { ...this.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      const e = (json as any)?.error
      throw new Error(
        `Cloud API ${res.status}: ${e?.message ?? 'unknown error'}` +
        (e?.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''),
      )
    }
    return json
  }

  async sendText(to: string, text: string, previewUrl = true): Promise<string> {
    const json = await this.post({
      messaging_product: 'whatsapp', recipient_type: 'individual', to,
      type: 'text', text: { preview_url: previewUrl, body: text },
    })
    return json?.messages?.[0]?.id ?? '(no id)'
  }

  async sendFile(to: string, path: string, caption?: string): Promise<string> {
    const ext = (path.match(/\.[^.\/]+$/)?.[0] ?? '').toLowerCase()
    const asImage = IMAGE_EXTS.has(ext)

    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('file', Bun.file(path), basename(path))
    const upRes = await fetch(`${this.graph}/${this.cfg.phoneNumberId}/media`, {
      method: 'POST', headers: this.auth, body: form,
    })
    const upJson = await upRes.json().catch(() => ({}))
    if (!upRes.ok || !(upJson as any)?.id) {
      throw new Error(`media upload failed (${upRes.status}): ${(upJson as any)?.error?.message ?? 'no id returned'}`)
    }

    const json = await this.post({
      messaging_product: 'whatsapp', recipient_type: 'individual', to,
      type: asImage ? 'image' : 'document',
      [asImage ? 'image' : 'document']: {
        id: (upJson as any).id,
        ...(caption ? { caption } : {}),
        ...(asImage ? {} : { filename: basename(path) }),
      },
    })
    return json?.messages?.[0]?.id ?? '(no id)'
  }

  async sendButtons(to: string, body: string, buttons: { id: string; title: string }[]): Promise<string> {
    const json = await this.post({
      messaging_product: 'whatsapp', recipient_type: 'individual', to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, 1024) },
        action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
      },
    })
    return json?.messages?.[0]?.id ?? '(no id)'
  }

  async sendTemplate(to: string, name: string, languageCode: string, bodyParams: string[]): Promise<string> {
    const json = await this.post({
      messaging_product: 'whatsapp', recipient_type: 'individual', to,
      type: 'template',
      template: {
        name, language: { code: languageCode },
        ...(bodyParams.length
          ? { components: [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: t })) }] }
          : {}),
      },
    })
    return json?.messages?.[0]?.id ?? '(no id)'
  }

  // Two-step: resolve the id to a short-lived URL, then fetch it. The second
  // request needs the Bearer token too, which is easy to miss.
  async downloadMedia(mediaRef: string): Promise<string> {
    const metaRes = await fetch(`${this.graph}/${mediaRef}`, { headers: this.auth })
    if (!metaRes.ok) throw new Error(`media lookup failed: HTTP ${metaRes.status}`)
    const meta = await metaRes.json() as { url?: string; mime_type?: string }
    if (!meta.url) throw new Error('Cloud API returned no media url — it may have expired (media lives ~5 days)')

    const binRes = await fetch(meta.url, { headers: this.auth })
    if (!binRes.ok) throw new Error(`media download failed: HTTP ${binRes.status}`)
    const buf = Buffer.from(await binRes.arrayBuffer())

    const subtype = (meta.mime_type ?? '').split(';')[0].split('/')[1] ?? 'bin'
    const ext = subtype.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const safeId = mediaRef.replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
    mkdirSync(this.cfg.inboxDir, { recursive: true })
    const path = join(this.cfg.inboxDir, `${Date.now()}-${safeId}.${ext}`)
    writeFileSync(path, buf)
    return path
  }

  async markRead(messageId: string): Promise<void> {
    try {
      await this.post({
        messaging_product: 'whatsapp', status: 'read', message_id: messageId,
        typing_indicator: { type: 'text' },
      })
    } catch {
      // Read receipts are cosmetic. Never let one break message handling.
    }
  }

  private verifySignature(raw: Buffer, header: string | null): boolean {
    if (!header?.startsWith('sha256=')) return false
    const expected = createHmac('sha256', this.cfg.appSecret).update(raw).digest()
    let got: Buffer
    try { got = Buffer.from(header.slice(7), 'hex') } catch { return false }
    // timingSafeEqual throws on length mismatch, and the length is not secret.
    if (got.length !== expected.length) return false
    return timingSafeEqual(got, expected)
  }

  private normalize(msg: RawMessage, profileName?: string): InboundMessage | undefined {
    if (!msg.from || !msg.id) return undefined
    const node = (msg as any)[msg.type ?? ''] as any
    const hasMedia = node && typeof node === 'object' && typeof node.id === 'string'
    const tsSec = Number(msg.timestamp ?? 0)

    let text: string
    switch (msg.type) {
      case 'text': text = msg.text?.body ?? ''; break
      case 'image': case 'video': case 'document':
        text = node?.caption ?? (msg.type === 'document'
          ? `(document: ${msg.document?.filename ?? 'file'})`
          : `(${msg.type})`)
        break
      case 'audio': text = msg.audio?.voice ? '(voice note)' : '(audio)'; break
      case 'sticker': text = '(sticker)'; break
      case 'location': {
        const l = msg.location ?? {}
        text = `(location: ${l.latitude},${l.longitude}${l.name ? ` — ${l.name}` : ''})`
        break
      }
      case 'interactive':
        text = msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? '(interactive reply)'
        break
      case 'button': text = msg.button?.text ?? '(button)'; break
      default: text = `(${msg.type ?? 'unknown'} message)`
    }

    return {
      senderId: normalizeWaId(msg.from),
      messageId: msg.id,
      timestamp: (Number.isFinite(tsSec) ? tsSec : 0) * 1000,
      text,
      profileName,
      msgType: msg.type ?? 'unknown',
      ...(hasMedia ? { mediaRef: node.id, mime: node.mime_type, fileName: node.filename } : {}),
      ...(msg.interactive?.button_reply?.id || msg.button?.payload
        ? { buttonId: msg.interactive?.button_reply?.id ?? msg.button?.payload }
        : {}),
    }
  }

  async start(handlers: TransportHandlers): Promise<void> {
    const { onMessage, onStatus } = handlers

    this.server = Bun.serve({
      port: this.cfg.port,
      hostname: this.cfg.bind,
      fetch: async req => {
        const url = new URL(req.url)

        if (url.pathname === '/health') return new Response('ok\n', { status: 200 })

        // Verification handshake: Meta GETs here when you save the webhook.
        if (req.method === 'GET' && url.pathname === '/webhook') {
          const mode = url.searchParams.get('hub.mode')
          const token = url.searchParams.get('hub.verify_token') ?? ''
          const challenge = url.searchParams.get('hub.challenge') ?? ''
          const a = Buffer.from(token)
          const b = Buffer.from(this.cfg.verifyToken)
          const ok = mode === 'subscribe' && a.length === b.length && timingSafeEqual(a, b)
          if (!ok) {
            onStatus('webhook verification failed (token mismatch)')
            return new Response('forbidden', { status: 403 })
          }
          onStatus('webhook verified')
          return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
        }

        if (req.method === 'POST' && url.pathname === '/webhook') {
          // Verify before parsing: re-serializing parsed JSON changes the bytes
          // and breaks the HMAC.
          const raw = Buffer.from(await req.arrayBuffer())
          if (!this.verifySignature(raw, req.headers.get('x-hub-signature-256'))) {
            onStatus('rejected webhook with bad signature')
            return new Response('invalid signature', { status: 403 })
          }

          let payload: any
          try { payload = JSON.parse(raw.toString('utf8')) } catch {
            return new Response('bad json', { status: 400 })
          }

          // Acknowledge fast, process after: a slow 200 makes Meta retry.
          queueMicrotask(() => {
            void (async () => {
              try {
                for (const entry of payload?.entry ?? []) {
                  for (const change of entry?.changes ?? []) {
                    const value = change?.value
                    if (!value?.messages) continue // statuses/read receipts
                    const nameOf = new Map<string, string>()
                    for (const c of value.contacts ?? []) {
                      if (c?.wa_id) nameOf.set(normalizeWaId(c.wa_id), c?.profile?.name ?? '')
                    }
                    for (const raw of value.messages as RawMessage[]) {
                      const m = this.normalize(raw, raw.from ? nameOf.get(normalizeWaId(raw.from)) : undefined)
                      if (m) await onMessage(m)
                    }
                  }
                }
              } catch (err) {
                onStatus(`error handling webhook: ${err}`)
              }
            })()
          })

          return new Response('ok', { status: 200 })
        }

        return new Response('not found', { status: 404 })
      },
    })

    onStatus(
      `listening on http://${this.cfg.bind}:${this.server.port}/webhook ` +
      `(api ${this.cfg.apiVersion}, phone id ${this.cfg.phoneNumberId})`,
    )
  }

  stop(): void {
    try { this.server?.stop(true) } catch {}
  }
}
