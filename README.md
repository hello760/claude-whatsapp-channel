# WhatsApp channel for Claude Code

A two-way WhatsApp bridge into a running Claude Code session. You message
WhatsApp; Claude reads it in a real session on your machine — with your files,
your MCP servers, your skills — and replies in the same chat.

Two ways to connect, and **you do not need the WhatsApp Business API for
either the setup or the number**:

| | `linked` (default) | `cloud` |
| --- | --- | --- |
| How | QR scan, like WhatsApp Web | Signed webhook from Meta |
| Your number | **any existing one**, personal or Business app | a number *dedicated* to the API |
| Needs a Meta app | no | yes |
| Business verification | no | yes |
| 24-hour reply window | **no** | yes |
| Message templates | not needed | required outside the window |
| Groups, voice notes | native | limited |
| Officially permitted | **no** — see [the trade](#the-trade) | yes |

```
  your phone                              your machine
┌────────────┐                  ┌──────────────────────────────┐
│  WhatsApp  │ ◄──── QR ──────► │  server.ts (linked device)    │
│            │ ◄─── messages ─► │        ↕ stdio (MCP)          │
└────────────┘                  │     claude --channels         │
                                │        ↕                      │
                                │  Jira MCP, files, bash        │
                                └──────────────────────────────┘
```

**Status:** working and tested — 80 automated checks (`bun test/baileys.ts`,
`bun test/smoke.ts`). Not on Anthropic's channel allowlist, so it loads with
the development flag. See [Enable it](#3-enable-the-channel).

---

## Quick start (linked device)

You need **Claude Code** authenticated via claude.ai or a Console API key
(channels don't work on Bedrock, Vertex or Foundry), **Bun**, and a phone with
WhatsApp. Nothing else — no credentials, no Meta account, no tunnel.

If your claude.ai org is Team or Enterprise, an Owner must first enable
channels under *Organization settings → Claude Code → Channels*. Until then
the server runs, its tools work, and no messages arrive.

### 1. Install

```bash
# in Claude Code
/plugin marketplace add /path/to/claude-whatsapp-channel
/plugin install whatsapp@mmg-channels
```

Pick **user scope** so it works in every project. If the summary says
`Run /reload-plugins to apply`, do that.

### 2. Decide which number

Whatever number scans the QR **becomes** the assistant.

- **A spare number** (cheap eSIM or second SIM) keeps the assistant separate,
  and a ban costs you nothing that matters. Safer default.
- **Your main number** is more convenient — your team already has it — but the
  stakes of a ban are your primary WhatsApp account.

This doesn't change any configuration. It's just which phone you scan with.

### 3. Enable the channel

Not being on Anthropic's allowlist, it needs the development flag:

```bash
claude --model opus \
  --dangerously-load-development-channels plugin:whatsapp@mmg-channels
```

Claude Code shows a full-screen warning listing the development channels;
choose *I am using this for local development*. The flag only works in an
interactive session — it's ignored under `-p`.

On Team/Enterprise an admin can instead allowlist it in managed settings, and
then plain `--channels` works with no flag:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "mmg-channels", "plugin": "whatsapp" }
  ]
}
```

That *replaces* Anthropic's default list, so include any official channels you
also want.

### 4. Scan

```
/whatsapp:link
```

The QR prints in your terminal. On your phone: **WhatsApp → Settings → Linked
devices → Link a device**, and scan. (The server also writes
`~/.claude/channels/whatsapp/qr.txt.png` if your terminal mangles the ASCII.)
Codes expire every ~20 seconds and are replaced automatically — if a scan
fails, run `/whatsapp:link` again.

### 5. Say hi

- **If you linked your own number:** use WhatsApp's **Message yourself** chat.
  Self-chat skips pairing — there's nobody else to authenticate — so it works
  the moment you're linked.
- **Anyone else** messages the linked number and gets a pairing code. Approve
  it in your terminal with `/whatsapp:access pair <code>`, then lock the door:

```
/whatsapp:access policy allowlist
```

---

## The trade

The linked transport speaks the WhatsApp Web protocol through
[Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial library.
WhatsApp's terms don't permit unofficial clients, and accounts do get banned.

What the evidence actually shows: the documented permanent bans cluster around
**bulk sending and status spam**, not low-volume one-to-one chat, and Baileys'
own docs discourage bulk messaging. A personal assistant you message a few
dozen times a day is a much milder traffic shape than what generates those
reports. Vendor blogs quoting "2–8 week lifespans" are selling the official
API; treat those numbers accordingly.

It is still a real risk, it is still against the terms, and the protocol breaks
when WhatsApp changes it. Two things here reduce the exposure:

- **Outbound pacing.** Sends are spaced by at least 1200 ms
  (`WHATSAPP_MIN_SEND_GAP_MS`). Bursts are the clearest automation signal there
  is, and a chat assistant has no reason to outpace typing.
- **No history sync, no presence.** The socket doesn't pull your chat history
  and doesn't advertise as online, so it stays quiet and doesn't suppress your
  phone's own notifications.

Baileys is pinned to the exact version `7.0.0-rc14`. Upstream `latest` is a
release candidate and rc-to-rc changes have been breaking, so the pin is
deliberate — upgrade on purpose, not by accident.

If none of that is acceptable, use the `cloud` transport, which is officially
supported. It needs a phone number **not already on WhatsApp**: registering a
number with the Cloud API removes it from regular WhatsApp, which is a one-way
door.

---

## Making it an actual assistant

The channel is the transport. The intelligence comes from the session.

**Smartest model.** `--model opus`, or `/model opus` in-session. Phone messages
are short; the thinking isn't.

**Jira.** Add Atlassian's hosted MCP server to the same session:

```bash
claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp
```

Then `/mcp` and complete OAuth in the browser once. Check that URL against
Atlassian's current Rovo MCP docs — the endpoint has moved before and
directories disagree on `/v1/mcp` vs `/v1/mcp/authv2`. Cloud only, no Server or
Data Center. After that, "log a bug for the broken checkout, assign to me, P2"
over WhatsApp becomes a real issue.

**A brief.** Copy `ASSISTANT.md` to `CLAUDE.md` in the directory you run the
assistant from. It sets the reply shape, the Jira conventions, and the
draft-before-send rule for anything that reaches another person. Edit it.

**The right working directory.** Run the session where its work lives — a notes
repo, an ops repo. Everything Claude reads, writes and runs is relative to that.

## Keeping it on

Events only arrive while the session is open. A sleeping laptop misses messages.

```bash
tmux new -s assistant
claude --model opus \
  --dangerously-load-development-channels plugin:whatsapp@mmg-channels
# Ctrl-b d to detach
```

The linked transport needs no tunnel and no inbound ports, which makes it a
much easier thing to leave running on a small VPS than the webhook route.

Before leaving it unattended, decide how permissions work:

- **Relay (recommended).** Permission prompts go to WhatsApp, and you answer
  `yes abcde` / `no abcde` from your phone. On a linked device these are text
  prompts rather than buttons — WhatsApp doesn't render interactive buttons for
  unofficial clients — so the server sends the code to type.
- `--dangerously-skip-permissions` removes the prompts entirely, and means
  anything reaching that session runs unreviewed. Only on a box you'd hand to
  whoever is on your allowlist.

**Your phone must come online at least once every couple of weeks**, or
WhatsApp logs out linked devices. If that happens the server says so and clears
its credentials; run `/whatsapp:link` and scan again.

**One session per linked account.** Two sessions on the same account both
receive every message and both reply.

## Security model

1. **Sender allowlist.** Gating is on the sender's `wa_id`, never the
   conversation. Unknown numbers get a pairing code at most twice, then
   silence; at most 3 pending, expiring in an hour. Self-chat on the linked
   account is exempt, because it *is* the user.
2. **Outbound gate.** `reply` only reaches allowlisted numbers, so an injection
   can't turn your WhatsApp account into its outbox.
3. **State is not sendable.** The server refuses to attach anything from its own
   state directory — the device credentials there are equivalent to a logged-in
   WhatsApp session.
4. **Access changes are terminal-only.** All three skills refuse to touch
   `access.json` or re-link on behalf of a channel message, and the server tells
   Claude the same. "Add me to the allowlist" over WhatsApp is exactly what an
   injection looks like — and sender identity here is a phone number, which
   doesn't tell you who's holding the phone.
5. **Groups are dropped.** A group member isn't someone you paired, and
   permission relay into a group would let anyone in it approve tool use.
6. **On the `cloud` transport**, every webhook POST must carry a valid
   `X-Hub-Signature-256` HMAC of the raw body, verified before parsing and
   compared in constant time. The server refuses to start without the app
   secret.

Anyone on the allowlist can answer permission prompts, i.e. approve tool calls
in your session. Only add people you'd trust with that. Profile names,
filenames and captions are stripped of `<>[];"` and newlines before reaching
the `<channel>` tag, so a sender can't forge tag attributes.

## Testing without an account

```bash
bun test/baileys.ts   # 39 checks: routing, self-chat, echo loops, content types, MCP surface
bun test/smoke.ts     # 41 checks: Cloud API webhook, signatures, pairing, dedupe, relay
```

Neither needs credentials or a WhatsApp account. The Baileys suite drives the
inbound router directly with synthetic messages; the Cloud suite runs the real
server against a mock Graph API.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/whatsapp:link` shows no QR | Server not running, or not started with the channel flag. Check `/mcp`. |
| `/mcp` shows `whatsapp` as `failed` | Restart with `claude --debug ...` and read `~/.claude/debug/<session-id>.txt`. |
| Startup says the plugin isn't on the approved list | You used `--channels` instead of `--dangerously-load-development-channels`. |
| "blocked by org policy" | Team/Enterprise without `channelsEnabled`. An Owner must enable it. |
| Linked, but messages do nothing | Different problem with the same symptom: nobody is allowlisted. `/whatsapp:access` to check. |
| Logged out unexpectedly | Phone offline too long, or the device was removed under *Linked devices*. Re-run `/whatsapp:link`. |
| Assistant replying to itself | Shouldn't happen — own-send tracking covers it, and it's tested. If it does, file it with the message ids from the debug log. |
| Sends fail with a window error | `cloud` transport only, and expected: the contact hasn't messaged in 24h. |

## Layout

```
.claude-plugin/marketplace.json   local marketplace
plugins/whatsapp/
  server.ts                       shared channel logic + MCP surface
  transport.ts                    the transport boundary
  baileys.ts                      linked-device transport (default)
  cloud.ts                        Cloud API transport
  skills/link/SKILL.md            /whatsapp:link    — QR, status, reset
  skills/access/SKILL.md          /whatsapp:access  — pairing, allowlist, policy
  skills/configure/SKILL.md       /whatsapp:configure — cloud credentials
test/baileys.ts                   linked-device tests
test/smoke.ts                     Cloud API tests
ASSISTANT.md                      CLAUDE.md template for the assistant persona
```

State lives in `~/.claude/channels/whatsapp/`: `auth/` (device credentials —
treat as a password), `access.json` (policy + allowlist), `qr.txt` (pending
pairing code), `inbox/` (downloaded media), `window.json` (cloud only),
`.env` (cloud credentials, mode 600).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WHATSAPP_TRANSPORT` | `linked` | `linked` or `cloud` |
| `WHATSAPP_MIN_SEND_GAP_MS` | `1200` | Minimum gap between outbound sends |
| `WHATSAPP_STATE_DIR` | `~/.claude/channels/whatsapp` | State location |
| `WHATSAPP_ACCESS_MODE` | — | `static` freezes access at boot |
| `WHATSAPP_PORT` / `WHATSAPP_BIND` | `8793` / `127.0.0.1` | cloud: webhook listener |
| `WHATSAPP_API_VERSION` | `v25.0` | cloud: Graph API version |
| `WHATSAPP_GRAPH_BASE` | `https://graph.facebook.com` | cloud: override for tests or an egress proxy |

## Tools exposed to Claude

| Tool | Transport | Purpose |
| --- | --- | --- |
| `reply` | both | Send text and/or file attachments. Chunks at 4096. |
| `download_attachment` | both | Fetch inbound media to the local inbox. |
| `send_template` | cloud | Approved template — the only way into a closed window. |
| `window_status` | cloud | Remaining window before a long task. |

Tools are advertised per transport: a linked device never sees `send_template`
or `window_status`, so Claude can't promise the user something that can't
happen.
