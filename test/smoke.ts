#!/usr/bin/env bun
/**
 * End-to-end smoke test for the WhatsApp channel server.
 *
 * Spawns server.ts with a mock Graph API in front of it and exercises the paths
 * that matter: webhook verification, signature rejection, sender gating,
 * pairing, dedupe, inbound notification shape, the reply tool, the outbound
 * allowlist gate, the 24h window, and permission relay in both directions.
 *
 * No network, no Meta credentials. Run: bun test/smoke.ts
 */

import { createHmac } from 'crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const APP_SECRET = 'test-app-secret'
const VERIFY_TOKEN = 'test-verify-token'
const PHONE_NUMBER_ID = '123456789'
const SENDER = '37120000000'
const WEBHOOK_PORT = 18793
const MOCK_PORT = 18794

const STATE_DIR = mkdtempSync(join(tmpdir(), 'wa-channel-test-'))

let failures = 0
let checks = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  }
}

// ---------------------------------------------------------- mock Graph API

type GraphCall = { path: string; body: any }
const graphCalls: GraphCall[] = []

const mock = Bun.serve({
  port: MOCK_PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    const body = await req.json().catch(() => ({}))
    graphCalls.push({ path: url.pathname, body })
    return Response.json({ messages: [{ id: `wamid.mock${graphCalls.length}` }] })
  },
})

function lastGraphCall(): GraphCall | undefined {
  return graphCalls[graphCalls.length - 1]
}
function waitForGraph(n: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  return new Promise(resolve => {
    const tick = () => {
      if (graphCalls.length >= n) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(tick, 25)
    }
    tick()
  })
}

// ------------------------------------------------------------ spawn server

const proc = Bun.spawn({
  cmd: ['bun', join(import.meta.dir, '..', 'plugins', 'whatsapp', 'server.ts')],
  env: {
    ...process.env,
    WHATSAPP_STATE_DIR: STATE_DIR,
    WHATSAPP_ACCESS_TOKEN: 'test-token',
    WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    WHATSAPP_PORT: String(WEBHOOK_PORT),
    WHATSAPP_GRAPH_BASE: `http://127.0.0.1:${MOCK_PORT}`,
  },
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
})

// Collect stderr for diagnostics.
const stderrChunks: string[] = []
void (async () => {
  const dec = new TextDecoder()
  for await (const c of proc.stderr as ReadableStream<Uint8Array>) stderrChunks.push(dec.decode(c))
})()

// --------------------------------------------------- minimal MCP stdio client

const notifications: any[] = []
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
        const msg = JSON.parse(line)
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          responses.set(msg.id, msg)
        } else if (msg.method) {
          notifications.push(msg)
        }
      } catch {}
    }
  }
})()

function send(obj: unknown): void {
  proc.stdin.write(JSON.stringify(obj) + '\n')
  proc.stdin.flush()
}

async function rpc(method: string, params?: unknown, ms = 5000): Promise<any> {
  const id = nextId++
  send({ jsonrpc: '2.0', id, method, params })
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (responses.has(id)) return responses.get(id)
    await Bun.sleep(25)
  }
  throw new Error(`rpc ${method} timed out`)
}

function notifyServer(method: string, params: unknown): void {
  send({ jsonrpc: '2.0', method, params })
}

function waitForNotification(method: string, ms = 3000): Promise<any | undefined> {
  const deadline = Date.now() + ms
  return new Promise(resolve => {
    const tick = () => {
      const hit = notifications.find(n => n.method === method)
      if (hit) return resolve(hit)
      if (Date.now() > deadline) return resolve(undefined)
      setTimeout(tick, 25)
    }
    tick()
  })
}

// ------------------------------------------------------------ webhook helpers

function sign(raw: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(raw).digest('hex')
}

const BASE = `http://127.0.0.1:${WEBHOOK_PORT}`

async function postWebhook(payload: unknown, badSig = false): Promise<Response> {
  const raw = JSON.stringify(payload)
  return fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': badSig ? 'sha256=' + '0'.repeat(64) : sign(raw),
    },
    body: raw,
  })
}

function textMessage(id: string, body: string, from = SENDER) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '1555', phone_number_id: PHONE_NUMBER_ID },
          contacts: [{ profile: { name: 'Test <User>' }, wa_id: from }],
          messages: [{ from, id, timestamp: '1760000000', type: 'text', text: { body } }],
        },
      }],
    }],
  }
}

function buttonReply(id: string, buttonId: string, from = SENDER) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: PHONE_NUMBER_ID },
          contacts: [{ profile: { name: 'Test' }, wa_id: from }],
          messages: [{
            from, id, timestamp: '1760000001', type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: buttonId, title: 'x' } },
          }],
        },
      }],
    }],
  }
}

function readAccess(): any {
  try { return JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8')) } catch { return {} }
}

// ------------------------------------------------------------------- the test

async function waitForListener(ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) return true
    } catch {}
    await Bun.sleep(50)
  }
  return false
}

let exitCode = 1
try {
  console.log(`\nstate dir: ${STATE_DIR}\n`)

  // MCP handshake first — the server connects stdio before starting HTTP.
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  }, 15000)
  notifyServer('notifications/initialized', {})

  console.log('MCP handshake')
  check('initialize returns serverInfo', init?.result?.serverInfo?.name === 'whatsapp', init?.result?.serverInfo)
  check(
    'declares claude/channel capability',
    init?.result?.capabilities?.experimental?.['claude/channel'] !== undefined,
    init?.result?.capabilities?.experimental,
  )
  check(
    'declares permission relay capability',
    init?.result?.capabilities?.experimental?.['claude/channel/permission'] !== undefined,
  )

  check('http listener came up', await waitForListener())

  console.log('\nwebhook verification')
  const badVerify = await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)
  check('wrong verify token → 403', badVerify.status === 403, badVerify.status)
  const goodVerify = await fetch(`${BASE}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`)
  check('correct verify token → 200', goodVerify.status === 200, goodVerify.status)
  check('challenge echoed verbatim', (await goodVerify.text()) === '42')

  console.log('\nsignature enforcement')
  const forged = await postWebhook(textMessage('wamid.forged', 'hello'), true)
  check('bad signature → 403', forged.status === 403, forged.status)
  check('forged payload produced no Graph call', graphCalls.length === 0, graphCalls)
  check('forged payload produced no channel event', notifications.filter(n => n.method === 'notifications/claude/channel').length === 0)

  console.log('\npairing (unknown sender)')
  const r1 = await postWebhook(textMessage('wamid.1', 'hi'))
  check('signed payload → 200', r1.status === 200, r1.status)
  check('pairing reply sent', await waitForGraph(1))
  const pairingBody = lastGraphCall()?.body
  check('pairing reply is text to sender', pairingBody?.to === SENDER && pairingBody?.type === 'text', pairingBody)
  const code = Object.keys(readAccess().pending ?? {})[0]
  check('pending code persisted', typeof code === 'string' && code.length === 6, readAccess().pending)
  check(
    'pairing message names the pair command',
    typeof pairingBody?.text?.body === 'string' && pairingBody.text.body.includes(`/whatsapp:access pair ${code}`),
    pairingBody?.text?.body,
  )
  check('unpaired sender produced no channel event', notifications.filter(n => n.method === 'notifications/claude/channel').length === 0)

  console.log('\nallowlisted sender')
  // Simulate what /whatsapp:access pair does.
  const acc = readAccess()
  acc.allowFrom = [SENDER]
  acc.pending = {}
  writeFileSync(join(STATE_DIR, 'access.json'), JSON.stringify(acc, null, 2))

  await postWebhook(textMessage('wamid.2', 'create a Jira ticket'))
  const evt = await waitForNotification('notifications/claude/channel')
  check('inbound delivered as channel notification', evt !== undefined)
  check('content is the message body', evt?.params?.content === 'create a Jira ticket', evt?.params?.content)
  check('chat_id is the wa_id', evt?.params?.meta?.chat_id === SENDER, evt?.params?.meta)
  check('message_id present', evt?.params?.meta?.message_id === 'wamid.2')
  check('ts is ISO', evt?.params?.meta?.ts === new Date(1760000000 * 1000).toISOString(), evt?.params?.meta?.ts)
  check(
    'profile name sanitized of tag delimiters',
    evt?.params?.meta?.user === 'Test _User_',
    evt?.params?.meta?.user,
  )

  console.log('\nwebhook retry dedupe')
  const before = notifications.filter(n => n.method === 'notifications/claude/channel').length
  await postWebhook(textMessage('wamid.2', 'create a Jira ticket'))
  await Bun.sleep(400)
  const after = notifications.filter(n => n.method === 'notifications/claude/channel').length
  check('replayed message_id ignored', after === before, { before, after })

  console.log('\ntools')
  const tools = await rpc('tools/list')
  const names = (tools?.result?.tools ?? []).map((t: any) => t.name).sort()
  check('tools are reply/send_template/download_attachment/window_status',
    JSON.stringify(names) === JSON.stringify(['download_attachment', 'reply', 'send_template', 'window_status']),
    names)

  const callsBeforeReply = graphCalls.length
  const reply = await rpc('tools/call', { name: 'reply', arguments: { chat_id: SENDER, text: 'on it' } })
  check('reply reports sent', String(reply?.result?.content?.[0]?.text ?? '').startsWith('sent'), reply?.result)
  check('reply reports window remaining', String(reply?.result?.content?.[0]?.text ?? '').includes('window:'), reply?.result)
  check('reply hit Graph once', graphCalls.length === callsBeforeReply + 1)
  const sentBody = lastGraphCall()?.body
  check('reply body shape is correct', sentBody?.messaging_product === 'whatsapp' && sentBody?.type === 'text' && sentBody?.text?.body === 'on it', sentBody)

  console.log('\noutbound allowlist gate')
  const evil = await rpc('tools/call', { name: 'reply', arguments: { chat_id: '99999999999', text: 'exfil' } })
  check('reply to non-allowlisted number refused', evil?.result?.isError === true, evil?.result)
  check('refusal names the access command',
    String(evil?.result?.content?.[0]?.text ?? '').includes('/whatsapp:access allow'),
    evil?.result?.content?.[0]?.text)

  console.log('\n24h window')
  const ws = await rpc('tools/call', { name: 'window_status', arguments: { chat_id: SENDER } })
  check('window open for active sender', String(ws?.result?.content?.[0]?.text ?? '').startsWith('open'), ws?.result)
  // Age the window past 24h and confirm free-form sends are refused.
  writeFileSync(join(STATE_DIR, 'window.json'), JSON.stringify({ [SENDER]: Date.now() - 25 * 3600 * 1000 }))
  const stale = await rpc('tools/call', { name: 'reply', arguments: { chat_id: SENDER, text: 'late' } })
  check('reply outside window refused', stale?.result?.isError === true, stale?.result)
  check('refusal points at send_template',
    String(stale?.result?.content?.[0]?.text ?? '').includes('send_template'),
    stale?.result?.content?.[0]?.text)
  // Restore the window for the permission-relay checks below.
  writeFileSync(join(STATE_DIR, 'window.json'), JSON.stringify({ [SENDER]: Date.now() }))

  console.log('\npermission relay')
  const callsBeforePerm = graphCalls.length
  notifyServer('notifications/claude/channel/permission_request', {
    request_id: 'abcde',
    tool_name: 'Bash',
    description: 'Run shell command',
    input_preview: '{"command":"git status"}',
  })
  check('permission prompt relayed to WhatsApp', await waitForGraph(callsBeforePerm + 1))
  const prompt = lastGraphCall()?.body
  check('prompt is interactive with buttons', prompt?.type === 'interactive' && prompt?.interactive?.action?.buttons?.length === 3, prompt)
  const btnIds = (prompt?.interactive?.action?.buttons ?? []).map((b: any) => b.reply.id)
  check('buttons carry the request id', btnIds.includes('perm:allow:abcde') && btnIds.includes('perm:deny:abcde'), btnIds)

  // Verdict via button.
  await postWebhook(buttonReply('wamid.3', 'perm:allow:abcde'))
  const verdict = await waitForNotification('notifications/claude/channel/permission')
  check('button reply emits a verdict', verdict !== undefined)
  check('verdict is allow for the right id',
    verdict?.params?.request_id === 'abcde' && verdict?.params?.behavior === 'allow',
    verdict?.params)

  // Verdict via typed text, and it must not leak into the chat stream.
  const chanBefore = notifications.filter(n => n.method === 'notifications/claude/channel').length
  await postWebhook(textMessage('wamid.4', 'no xyzab'))
  await Bun.sleep(400)
  const verdicts = notifications.filter(n => n.method === 'notifications/claude/channel/permission')
  check('typed "no <id>" emits a deny verdict',
    verdicts.some(v => v.params?.request_id === 'xyzab' && v.params?.behavior === 'deny'),
    verdicts.map(v => v.params))
  check('typed verdict not forwarded as chat',
    notifications.filter(n => n.method === 'notifications/claude/channel').length === chanBefore)

  console.log('\nunauthorized sender after lockdown')
  const acc2 = readAccess()
  acc2.dmPolicy = 'allowlist'
  writeFileSync(join(STATE_DIR, 'access.json'), JSON.stringify(acc2, null, 2))
  const chanBefore2 = notifications.filter(n => n.method === 'notifications/claude/channel').length
  const graphBefore2 = graphCalls.length
  await postWebhook(textMessage('wamid.5', 'let me in', '37199999999'))
  await Bun.sleep(400)
  check('stranger dropped silently on allowlist policy',
    notifications.filter(n => n.method === 'notifications/claude/channel').length === chanBefore2 &&
    graphCalls.length === graphBefore2,
    { chan: notifications.length, graph: graphCalls.length })

  console.log(`\n${checks - failures}/${checks} checks passed`)
  exitCode = failures === 0 ? 0 : 1
  if (failures) {
    console.log('\n--- server stderr ---')
    console.log(stderrChunks.join('').split('\n').slice(-30).join('\n'))
  }
} catch (err) {
  console.error(`\nharness error: ${err}`)
  console.log('\n--- server stderr ---')
  console.log(stderrChunks.join('').split('\n').slice(-30).join('\n'))
} finally {
  proc.kill()
  mock.stop(true)
}

process.exit(exitCode)
