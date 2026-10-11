#!/usr/bin/env bun
/**
 * Tests for the linked-device transport.
 *
 * Part 1 drives the inbound router directly with synthetic WhatsApp messages —
 * no network, no account. This is where the subtle bugs live: on a linked
 * device the user's own self-chat messages and the assistant's own replies both
 * arrive with fromMe set, and confusing them makes the assistant answer itself
 * in a loop.
 *
 * Part 2 boots the real server in linked mode to confirm the transport-dependent
 * MCP surface: no template or window tools, and no 24h-window language in the
 * instructions, because neither applies to a linked device.
 */

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BaileysTransport } from '../plugins/whatsapp/baileys.ts'
import type { InboundMessage } from '../plugins/whatsapp/transport.ts'

let failures = 0
let checks = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`) }
}

const OWN = '37120000000'
const OTHER = '37129999999'
const STATE = mkdtempSync(join(tmpdir(), 'wa-baileys-test-'))

// ------------------------------------------------- part 1: the inbound router

const delivered: InboundMessage[] = []

const t = new BaileysTransport({
  authDir: join(STATE, 'auth'),
  inboxDir: join(STATE, 'inbox'),
  qrPath: join(STATE, 'qr.txt'),
  minSendGapMs: 0,
})

// Stand in for a linked socket: private fields are compile-time only, and the
// router is what we want to exercise, not the socket.
const priv = t as unknown as {
  ownId: string
  handlers: { onMessage: (m: InboundMessage) => Promise<void>; onStatus: (s: string) => void }
  ownSends: Set<string>
  handleRaw: (msg: any) => Promise<void>
}
priv.ownId = `${OWN}@s.whatsapp.net`
priv.handlers = {
  onMessage: async m => { delivered.push(m) },
  onStatus: () => {},
}

function msg(opts: {
  id: string
  jid: string
  fromMe?: boolean
  message: any
  pushName?: string
  ts?: number
}) {
  return {
    key: { id: opts.id, remoteJid: opts.jid, fromMe: opts.fromMe ?? false },
    message: opts.message,
    pushName: opts.pushName,
    messageTimestamp: opts.ts ?? 1760000000,
  }
}

const SELF_JID = `${OWN}@s.whatsapp.net`
const OTHER_JID = `${OTHER}@s.whatsapp.net`

function lastDelivered(): InboundMessage | undefined {
  return delivered[delivered.length - 1]
}

console.log('\nrouting')

await priv.handleRaw(msg({ id: 'm1', jid: OTHER_JID, message: { conversation: 'hello' }, pushName: 'Ann' }))
check('inbound from another number is delivered', lastDelivered()?.messageId === 'm1', delivered.length)
check('sender is the wa_id digits', lastDelivered()?.senderId === OTHER, lastDelivered()?.senderId)
check('pushName becomes profileName', lastDelivered()?.profileName === 'Ann')

let n = delivered.length
await priv.handleRaw(msg({ id: 'm2', jid: OTHER_JID, fromMe: true, message: { conversation: 'to a colleague' } }))
check('fromMe to someone else is dropped (user texting a third party)', delivered.length === n)

await priv.handleRaw(msg({ id: 'm3', jid: SELF_JID, fromMe: true, message: { conversation: 'note to self' } }))
check('fromMe in self-chat is delivered (this is the user)', lastDelivered()?.messageId === 'm3', delivered.length)

n = delivered.length
priv.ownSends.add('m4')
await priv.handleRaw(msg({ id: 'm4', jid: SELF_JID, fromMe: true, message: { conversation: "assistant's own reply" } }))
check('our own send echoing back in self-chat is dropped (no self-reply loop)', delivered.length === n)

n = delivered.length
await priv.handleRaw(msg({ id: 'm5', jid: '123456789-987@g.us', message: { conversation: 'group chatter' } }))
check('group messages are dropped', delivered.length === n)

await priv.handleRaw(msg({ id: 'm6', jid: 'status@broadcast', message: { conversation: 'a status' } }))
check('status broadcasts are dropped', delivered.length === n)

await priv.handleRaw(msg({ id: 'm7', jid: OTHER_JID, message: { reactionMessage: { text: '👍' } } }))
check('reactions are dropped', delivered.length === n)

await priv.handleRaw(msg({ id: 'm8', jid: OTHER_JID, message: { protocolMessage: {} } }))
check('protocol messages are dropped', delivered.length === n)

console.log('\ndevice suffixes and normalization')

await priv.handleRaw(msg({ id: 'm9', jid: `${OTHER}:17@s.whatsapp.net`, message: { conversation: 'from a linked device' } }))
check('device-suffixed jid normalizes to the bare wa_id', lastDelivered()?.senderId === OTHER, lastDelivered()?.senderId)

await priv.handleRaw(msg({ id: 'm10', jid: SELF_JID, fromMe: true, message: { conversation: 'x' } }))
check('isSelf recognizes the linked account', t.isSelf(OWN) === true)
check('isSelf rejects another number', t.isSelf(OTHER) === false)
check('isSelf tolerates + and spaces', t.isSelf(`+${OWN}`) === true)
check('linkedAs reports the bare wa_id', t.linkedAs() === OWN, t.linkedAs())

console.log('\ncontent types')

await priv.handleRaw(msg({
  id: 'c1', jid: OTHER_JID,
  message: { extendedTextMessage: { text: 'a link https://example.com' } },
}))
check('extendedTextMessage text is extracted', lastDelivered()?.text === 'a link https://example.com', lastDelivered()?.text)

await priv.handleRaw(msg({
  id: 'c2', jid: OTHER_JID,
  message: { imageMessage: { caption: 'look at this', mimetype: 'image/jpeg' } },
}))
check('image caption becomes the text', lastDelivered()?.text === 'look at this')
check('image carries a mediaRef for download', lastDelivered()?.mediaRef === 'c2', lastDelivered()?.mediaRef)
check('image mime is passed through', lastDelivered()?.mime === 'image/jpeg')

await priv.handleRaw(msg({
  id: 'c3', jid: OTHER_JID,
  message: { imageMessage: { mimetype: 'image/jpeg' } },
}))
check('captionless image gets a placeholder', lastDelivered()?.text === '(image)', lastDelivered()?.text)

await priv.handleRaw(msg({
  id: 'c4', jid: OTHER_JID,
  message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } },
}))
check('voice note is labelled as one', lastDelivered()?.text === '(voice note)', lastDelivered()?.text)
check('voice note is downloadable', lastDelivered()?.mediaRef === 'c4')

await priv.handleRaw(msg({
  id: 'c5', jid: OTHER_JID,
  message: { audioMessage: { ptt: false, mimetype: 'audio/mp4' } },
}))
check('non-ptt audio is distinguished from a voice note', lastDelivered()?.text === '(audio)', lastDelivered()?.text)

await priv.handleRaw(msg({
  id: 'c6', jid: OTHER_JID,
  message: { documentMessage: { fileName: 'q3-report.pdf', mimetype: 'application/pdf' } },
}))
check('document filename appears in the text', lastDelivered()?.text === '(document: q3-report.pdf)', lastDelivered()?.text)
check('document filename is on the message', lastDelivered()?.fileName === 'q3-report.pdf')

await priv.handleRaw(msg({
  id: 'c7', jid: OTHER_JID,
  message: { locationMessage: { degreesLatitude: 56.95, degreesLongitude: 24.1, name: 'Riga' } },
}))
check('location renders coordinates', (lastDelivered()?.text ?? '').includes('56.95,24.1'), lastDelivered()?.text)

await priv.handleRaw(msg({
  id: 'c8', jid: OTHER_JID,
  message: { buttonsResponseMessage: { selectedButtonId: 'perm:allow:abcde', selectedDisplayText: 'Allow' } },
}))
check('button reply exposes its id for permission relay', lastDelivered()?.buttonId === 'perm:allow:abcde', lastDelivered()?.buttonId)

console.log('\ncapabilities')
check('no 24h service window on a linked device', t.capabilities.serviceWindow === false)
check('no templates on a linked device', t.capabilities.templates === false)
check('no interactive buttons on a linked device', t.capabilities.buttons === false)

console.log('\nsending before link')
try {
  // ownId is set above, so clear it to simulate an unlinked socket.
  priv.ownId = ''
  await t.sendText(OTHER, 'should fail')
  check('sending before link is refused', false, 'no error thrown')
} catch (err) {
  const m = err instanceof Error ? err.message : String(err)
  check('sending before link is refused with an actionable message',
    m.includes('/whatsapp:link') || m.includes('not connected'), m)
}

t.stop()

// --------------------------------------- part 2: MCP surface in linked mode

console.log('\nserver in linked mode')

const proc = Bun.spawn({
  cmd: ['bun', join(import.meta.dir, '..', 'plugins', 'whatsapp', 'server.ts')],
  env: {
    ...process.env,
    WHATSAPP_TRANSPORT: 'linked',
    WHATSAPP_STATE_DIR: mkdtempSync(join(tmpdir(), 'wa-linked-srv-')),
  },
  stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
})

const stderrChunks: string[] = []
void (async () => {
  const dec = new TextDecoder()
  for await (const c of proc.stderr as ReadableStream<Uint8Array>) stderrChunks.push(dec.decode(c))
})()

const responses = new Map<number, any>()
let nextId = 1
void (async () => {
  const dec = new TextDecoder()
  let buf = ''
  for await (const c of proc.stdout as ReadableStream<Uint8Array>) {
    buf += dec.decode(c)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const m = JSON.parse(line)
        if (m.id !== undefined) responses.set(m.id, m)
      } catch {}
    }
  }
})()

async function rpc(method: string, params?: unknown, ms = 20000): Promise<any> {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  proc.stdin.flush()
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (responses.has(id)) return responses.get(id)
    await Bun.sleep(25)
  }
  throw new Error(`rpc ${method} timed out`)
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' },
  })
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
  proc.stdin.flush()

  check('server starts with no credentials at all', init?.result?.serverInfo?.name === 'whatsapp', init?.result)
  check('still declares the channel capability',
    init?.result?.capabilities?.experimental?.['claude/channel'] !== undefined)

  const instr: string = init?.result?.instructions ?? ''
  check('instructions omit the 24h window on this transport',
    !instr.includes('24 hours') && !instr.includes('24h'),
    instr.slice(0, 120))
  check('instructions still carry the injection warning', instr.includes('prompt injection'))

  const tools = await rpc('tools/list')
  const names = (tools?.result?.tools ?? []).map((x: any) => x.name).sort()
  check('only the applicable tools are offered',
    JSON.stringify(names) === JSON.stringify(['download_attachment', 'reply']), names)
  check('send_template is not offered without template support', !names.includes('send_template'))
  check('window_status is not offered without a window', !names.includes('window_status'))

  const replyTool = (tools?.result?.tools ?? []).find((x: any) => x.name === 'reply')
  check('reply description makes no 24h promise',
    !String(replyTool?.description ?? '').includes('24h'),
    replyTool?.description)
} catch (err) {
  failures++
  console.log(`  ✗ harness error — ${err}`)
  console.log('\n--- server stderr ---')
  console.log(stderrChunks.join('').split('\n').slice(-20).join('\n'))
} finally {
  proc.kill()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
