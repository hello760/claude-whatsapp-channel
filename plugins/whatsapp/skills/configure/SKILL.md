---
name: configure
description: Set up the WhatsApp channel — save Cloud API credentials and review access policy. Use when the user pastes a WhatsApp access token, phone number ID or app secret, asks to configure WhatsApp, asks "how do I set this up" or "who can reach me", or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(echo *)
  - Bash(chmod *)
  - Bash(openssl *)
---

# /whatsapp:configure — WhatsApp Channel Setup (cloud transport)

Writes Cloud API credentials to `<state-dir>/.env` and orients the user on
access policy. The server reads `.env` once at boot.

**This is only for the `cloud` transport.** The default `linked` transport
needs no credentials at all — it pairs by QR scan. If `WHATSAPP_TRANSPORT` is
unset or `linked`, tell the user to run `/whatsapp:link` instead and stop here.
Only continue if they have deliberately chosen the Cloud API, which also
requires a phone number not already registered on WhatsApp.

**Resolve the state directory first** (it may be overridden for multi-number
or per-project setups):

```bash
echo "${WHATSAPP_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/whatsapp}"
```

Use the printed path everywhere below in place of `<state-dir>`. The default
is `~/.claude/channels/whatsapp`.

Arguments passed: `$ARGUMENTS`

---

## The four required values

| Key | Where it comes from |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | Meta app → WhatsApp → API Setup. Use a **System User token** with `whatsapp_business_messaging`; the 24-hour temporary token is for testing only and will strand the channel tomorrow. |
| `WHATSAPP_PHONE_NUMBER_ID` | Same page — the **Phone number ID**, not the phone number itself. |
| `WHATSAPP_APP_SECRET` | Meta app → App settings → Basic → App Secret. |
| `WHATSAPP_VERIFY_TOKEN` | Any random string you invent. You paste the same value into Meta's webhook config. Generate one with `openssl rand -hex 16`. |

Optional: `WHATSAPP_PORT` (default 8793), `WHATSAPP_BIND` (default
127.0.0.1), `WHATSAPP_API_VERSION` (default v25.0),
`WHATSAPP_GRAPH_BASE` (override the Graph host; for testing or an egress proxy).

The server refuses to start without all four required values, and names which
are missing. `WHATSAPP_APP_SECRET` in particular is not optional even though
Meta calls signature validation optional: the webhook is a public endpoint, and
the signature is the only thing separating the open internet from text injected
into this session.

---

## Dispatch on arguments

### No args — status and guidance

1. **Credentials** — read `<state-dir>/.env`. For each of the four keys show
   set/not-set. Never print a secret value; show at most the first 6 characters
   of the token followed by `...`.

2. **Access** — read `<state-dir>/access.json` (missing file = defaults:
   `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count and the wa_ids
   - Pending pairings: count, with codes and age

3. **Webhook** — remind them of the callback URL shape:
   `https://<your-tunnel-or-host>/webhook`, with the verify token from `.env`,
   subscribed to the **messages** field.

4. **What next** — end with one concrete step:
   - Missing credentials → name exactly which, and where each comes from
   - All set, nobody allowed → *"Message your WhatsApp Business number. You'll
     get a pairing code; approve it with `/whatsapp:access pair <code>`."*
   - Someone allowed → *"Ready. Message the business number to reach Claude."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is not a resting state; it is a way to capture
wa_ids you don't know yet. Once they're captured, turn it off.

1. Read the allowlist and tell the user who's in it.
2. Ask: *"Is that everyone who should reach you here?"*
3. **If yes and policy is still `pairing`** → offer to run
   `/whatsapp:access policy allowlist`. Proactively; don't wait to be asked.
4. **If people are missing** → *"Have them message the number; approve each
   with `/whatsapp:access pair <code>`. Run this again when everyone's in."*
5. **If policy is already `allowlist`** → confirm that's the locked state. To
   add someone later: `/whatsapp:access allow <wa_id>` with their number in
   international format, no `+`.

Never frame `pairing` as the correct long-term choice.

### `<key>=<value>` pairs — save them

The user may paste one or several, in any order, e.g.
`WHATSAPP_PHONE_NUMBER_ID=123 WHATSAPP_ACCESS_TOKEN=EAA...`.

1. `mkdir -p` the resolved `<state-dir>`.
2. Read the existing `.env` if present. Update or add each supplied key,
   preserving every other line. No quotes around values.
3. `chmod 600 <state-dir>/.env` — these are credentials.
4. Confirm which keys were written (never echo the values), then show the
   no-args status.
5. Remind them the server reads `.env` at boot, so the session needs a restart
   for credential changes to take effect.

### A bare token-looking argument

If `$ARGUMENTS` is a single long opaque string, ask which key it is rather than
guessing — a token written into `WHATSAPP_APP_SECRET` fails with a confusing
signature error much later.

### `genverify` — mint a verify token

Run `openssl rand -hex 16`, save it as `WHATSAPP_VERIFY_TOKEN`, and tell the
user to paste the same value into Meta's webhook configuration.

### `clear` — remove credentials

Delete the four keys from `.env` (or the file if nothing else remains).
Confirm what was removed.

---

## Implementation notes

- The channels dir may not exist if the server has never run. Missing file =
  not configured, not an error.
- `access.json` is re-read on every inbound message, so policy changes via
  `/whatsapp:access` apply immediately with no restart. `.env` is not.
- If the user reports the webhook handshake failing in Meta's dashboard, the
  usual causes are: the tunnel isn't running, the path is missing `/webhook`,
  or the verify token in Meta doesn't match `.env`.
