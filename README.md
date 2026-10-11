# WhatsApp channel for Claude Code

A two-way WhatsApp bridge into a running Claude Code session, built on the
official **WhatsApp Cloud API**. You message your WhatsApp Business number;
Claude reads it in a real session on your machine — with your files, your MCP
servers, your skills — and replies in the same chat.

```
  your phone                  Meta                 your machine
┌────────────┐          ┌──────────────┐     ┌──────────────────────────┐
│  WhatsApp  │ ───────► │  Cloud API   │ ──► │  tunnel → server.ts      │
│            │ ◄─────── │              │ ◄── │        ↕ stdio (MCP)     │
└────────────┘          └──────────────┘     │     claude --channels    │
                                             │        ↕                 │
                                             │  Jira MCP, files, bash   │
                                             └──────────────────────────┘
```

**Status:** working, tested (`bun test/smoke.ts` — 41 checks), not on
Anthropic's channel allowlist. See [Enabling it](#4-enable-the-channel).

---

## What you need first

- **Claude Code** authenticated with a claude.ai account or Console API key.
  Channels don't work on Bedrock, Vertex/Agent Platform, or Foundry.
- **Bun** — `bun --version`. The server is a Bun script.
- **A Meta developer app** with WhatsApp added, and a phone number for it.
- **A public HTTPS URL** pointing at this server. Unlike Telegram, the Cloud
  API only *pushes*: Meta POSTs to a webhook, so something has to be reachable
  from the internet. A `cloudflared` tunnel is the quickest option.
- **If your Claude.ai org is Team or Enterprise**, an Owner must enable
  channels first under *Organization settings → Claude Code → Channels*.
  Until then the server connects, its tools work, and no messages arrive.

---

## 1. Set up WhatsApp on Meta's side

1. At [developers.facebook.com](https://developers.facebook.com/apps) create an
   app (type **Business**) and add the **WhatsApp** product.
2. Under **WhatsApp → API Setup**, note:
   - **Phone number ID** (not the phone number) → `WHATSAPP_PHONE_NUMBER_ID`
   - A test number is provided free; for real use, add your own business number.
3. Create a **long-lived token**. The 24-hour token on that page is for
   testing and will strand the channel tomorrow. Instead: *Business Settings →
   System Users →* add a system user with access to the app, then **Generate
   token** with scopes `whatsapp_business_messaging` and
   `whatsapp_business_management`. → `WHATSAPP_ACCESS_TOKEN`
4. **App settings → Basic → App Secret** → `WHATSAPP_APP_SECRET`
5. Invent a verify token — any random string. `openssl rand -hex 16`.
   → `WHATSAPP_VERIFY_TOKEN`

Leave the webhook configuration for step 3; it needs the tunnel URL.

## 2. Install the plugin

This marketplace isn't public, so add it from disk:

```bash
# in Claude Code
/plugin marketplace add /path/to/claude-whatsapp-channel
/plugin install whatsapp@mmg-channels
```

Choose **user scope** so it's available in every project. If the install
summary says `Run /reload-plugins to apply`, do that so the configure command
appears.

Then save your credentials:

```
/whatsapp:configure WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_ACCESS_TOKEN=... WHATSAPP_APP_SECRET=... WHATSAPP_VERIFY_TOKEN=...
```

They're written to `~/.claude/channels/whatsapp/.env`, mode 600. Run
`/whatsapp:configure` with no arguments any time for status.

## 3. Expose the webhook

The server listens on `127.0.0.1:8793` by default. Put a tunnel in front:

```bash
cloudflared tunnel --url http://localhost:8793
# → https://something-random.trycloudflare.com
```

Then in Meta: **WhatsApp → Configuration → Webhook → Edit**

- **Callback URL**: `https://something-random.trycloudflare.com/webhook`
- **Verify token**: your `WHATSAPP_VERIFY_TOKEN`
- Click **Verify and save** — this only succeeds while the channel is running,
  so start Claude Code (step 4) first, then come back and save.
- Under **Webhook fields**, subscribe to **messages**.

A quick-tunnel URL changes every restart. For anything lasting, use a named
Cloudflare tunnel or a VPS with a real domain and a reverse proxy.

## 4. Enable the channel

This plugin is not on Anthropic's channel allowlist, so `--channels` alone
won't register it. Two ways in:

**Development flag** (what you'll use day to day):

```bash
claude --dangerously-load-development-channels plugin:whatsapp@mmg-channels
```

Claude Code shows a full-screen warning listing the development channels;
choose *I am using this for local development*. The flag must run in an
interactive session — it's ignored under `-p`.

**Org allowlist** (cleaner, Team/Enterprise only). An admin adds it to managed
settings, and then plain `--channels` works with no scary flag:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "mmg-channels", "plugin": "whatsapp" }
  ]
}
```

Note this *replaces* Anthropic's default allowlist, so list any official
channels you also want.

## 5. Pair your phone and lock it down

1. Message your WhatsApp Business number from your phone.
2. You get back a 6-character pairing code.
3. In Claude Code: `/whatsapp:access pair <code>`
4. Then close the door:

```
/whatsapp:access policy allowlist
```

Now only paired numbers reach the session, and everyone else is dropped
silently. Add a teammate later with `/whatsapp:access allow 37120000000`
(international format, no `+`).

---

## Making it an actual assistant

The channel is only the transport. The intelligence and the integrations come
from the session it's attached to.

### Use the smartest model

```bash
claude --model opus --dangerously-load-development-channels plugin:whatsapp@mmg-channels
```

Or `/model opus` in-session. Phone messages are short; the thinking isn't.

### Wire up Jira

Add Atlassian's hosted MCP server to the same session:

```bash
claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp
```

Then run `/mcp` in a session and complete the OAuth flow in the browser once.
Verify that URL against Atlassian's current Rovo MCP docs — the endpoint has
moved before, and directories disagree on `/v1/mcp` vs `/v1/mcp/authv2`.
Cloud only; no Server or Data Center.

After that, "log a bug for the broken checkout, assign to me, P2" over WhatsApp
becomes a real Jira issue.

### Give it a brief

Drop `ASSISTANT.md` (in this repo) into the project directory you run the
assistant from, as `CLAUDE.md`. It sets the tone, the reply shape, and the
rules for acting on behalf of the team. Edit it — it's a starting point, not a
finished policy.

### Pick the right working directory

Run the assistant session from wherever its work lives — a notes repo, an ops
repo, a scratch directory. Everything Claude reads and writes is relative to
that, and `bash` runs there.

---

## Keeping it on

Channel events only arrive while the session is open. A laptop that sleeps is a
laptop that misses messages.

```bash
# on a small always-on box
tmux new -s assistant
cloudflared tunnel run my-assistant &   # a named tunnel, not a quick one
claude --model opus \
  --dangerously-load-development-channels plugin:whatsapp@mmg-channels
# Ctrl-b d to detach
```

Two things to decide before leaving it unattended:

- **Permission prompts pause the session.** This plugin relays them to WhatsApp
  as Allow/Deny buttons, so you can answer from your phone. That's the
  recommended setup.
- `--dangerously-skip-permissions` removes the prompts entirely. It also means
  anything reaching that session runs unreviewed. Only on a box you'd be
  comfortable handing to whoever is on the allowlist.

**One session per number.** Two sessions on the same phone number ID both get
every webhook and both reply. Run one.

---

## Limits worth knowing before you build on it

| Limit | Effect |
| --- | --- |
| **24-hour window** | WhatsApp only delivers free-form messages within 24h of the contact's last message. The `reply` tool reports the remaining time and refuses cleanly when closed. A long task whose result lands later will not deliver — `send_template` with a pre-approved template is the only way back in. |
| **Messaging limits** | New numbers start capped (commonly 250 unique recipients/day) and scale with quality rating. Irrelevant for a personal assistant, relevant if you point it at customers. |
| **Templates need approval** | Submitted and reviewed in WhatsApp Manager. Not instant. |
| **Voice notes** | Download fine as `.ogg`, but Claude Code can't hear them. It will say so rather than guess. Add a transcription step (local Whisper in a hook, or an API call in a skill) if voice matters. |
| **Media expiry** | Inbound media is fetchable from Meta for about 5 days. |
| **Text cap** | 4096 characters per message; longer replies are split on paragraph boundaries. |
| **No history** | The Cloud API gives you messages as they arrive, nothing earlier. |
| **Rate limit** | Roughly one message every 6 seconds to the same recipient. |

Pricing and the free-service-message allowance change regularly — check Meta's
current pricing page rather than any number quoted in a blog post.

## Security model

The webhook is a public URL. Four things stand between it and your shell:

1. **Signature verification.** Every POST must carry a valid
   `X-Hub-Signature-256` HMAC of the raw body under your app secret. Computed
   before the JSON is parsed, compared in constant time. The server refuses to
   start without `WHATSAPP_APP_SECRET` — an unverified endpoint is an open
   prompt-injection hole.
2. **Sender allowlist.** Gating is on the sender's `wa_id`, never the
   conversation. Unknown numbers get a pairing code at most twice, then
   silence; at most 3 pending at a time, expiring in an hour.
3. **Outbound gate.** `reply` can only target allowlisted numbers, so a prompt
   injection can't turn your business number into its outbox. The server also
   refuses to send its own state directory as an attachment.
4. **Access changes are terminal-only.** Both skills refuse to touch
   `access.json` on behalf of a channel message, and the server's instructions
   tell Claude the same. "Add me to the allowlist" arriving over WhatsApp is
   exactly what an injection looks like.

Beyond that: **anyone on the allowlist can answer permission prompts**, which
means approving tool calls in your session. Only add people you'd trust with
that. Sanitized profile names, filenames and captions are stripped of
`<>[];"` and newlines before they reach the `<channel>` tag, so a sender can't
forge tag attributes.

## Testing without Meta

```bash
bun test/smoke.ts
```

Spawns the server against a mock Graph API and exercises webhook verification,
signature rejection, pairing, retry dedupe, the inbound notification shape, the
reply tool, the outbound gate, window expiry, and permission relay in both
directions. No credentials, no network.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Meta's "Verify and save" fails | Tunnel not running, URL missing `/webhook`, or verify token mismatch. The channel must be live to answer the handshake. |
| Messages arrive in WhatsApp but nothing in the session | Check `/mcp` for the server's status. If `failed`, restart with `claude --debug ...` and read `~/.claude/debug/<session-id>.txt`. |
| Startup notice says the plugin isn't on the approved list | You passed `--channels` instead of `--dangerously-load-development-channels`, or your org's `allowedChannelPlugins` doesn't include it. |
| "blocked by org policy" | Team/Enterprise org without `channelsEnabled`. An Owner has to enable it. |
| Replies fail with a window error | The contact hasn't messaged in 24h. Expected — use `send_template` or wait for them. |
| `EADDRINUSE` on 8793 | Stale server from a killed session. `lsof -i :8793`, kill it. |
| Nothing after moving machines | Quick-tunnel URLs change on every restart. Re-save the webhook URL in Meta, or use a named tunnel. |

## Layout

```
.claude-plugin/marketplace.json   local marketplace
plugins/whatsapp/
  server.ts                       the channel (MCP server + webhook listener)
  .mcp.json                       how Claude Code spawns it
  skills/configure/SKILL.md       /whatsapp:configure
  skills/access/SKILL.md          /whatsapp:access
test/smoke.ts                     end-to-end test against a mock Graph API
ASSISTANT.md                      CLAUDE.md template for the assistant persona
```

State lives in `~/.claude/channels/whatsapp/`: `.env` (credentials, 600),
`access.json` (policy + allowlist), `window.json` (24h tracking), `inbox/`
(downloaded media), `approved/` (pairing handoff).

## Tools exposed to Claude

| Tool | Purpose |
| --- | --- |
| `reply` | Send text and/or file attachments. Chunks at 4096, reports window remaining. |
| `send_template` | Send an approved template — the only way to reach a closed window. |
| `download_attachment` | Fetch inbound media by id to the local inbox. |
| `window_status` | Check remaining window before committing to a long task. |
