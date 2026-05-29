# Migrating from whatsapp-web.js to OpenBSP

This guide is for teams running on
[`whatsapp-web.js`](https://github.com/wwebjs/whatsapp-web.js) — the Node.js
library that drives a headless WhatsApp Web session via Puppeteer — and want to
move to OpenBSP.

Audience: developers comfortable with HTTP and JSON.

## Read this first: it's not a drop-in swap

`whatsapp-web.js` and OpenBSP sit on opposite sides of WhatsApp's API
boundary. Migrating is two changes layered on top of each other:

1. **Account model change.** `whatsapp-web.js` uses a *personal* WhatsApp
   account (the same one on your phone). OpenBSP connects to the **WhatsApp
   Business API** (Cloud API) under a WABA (WhatsApp Business Account),
   registered with Meta, on a business-owned phone number.
2. **API change.** `whatsapp-web.js` is a long-running Node process emitting
   events. OpenBSP is an HTTP+webhook service. You're not just changing a
   library call shape — you're changing the runtime model.

The benefits: official Meta support, no ban risk, predictable behavior, server
deployments without Puppeteer/Chrome dependencies, multi-tenant orgs out of
the box.

The costs: features your code may rely on (group management, status messages,
communities, polls, etc.) don't exist on the Cloud API and won't on OpenBSP
either. You can't initiate conversations freely — outbound to a new contact
requires a pre-approved template.

If your bot needs to manage groups, post status updates, or message any number
without prior consent, **OpenBSP cannot do those things**, period. That's a
Meta restriction, not an OpenBSP one. Read the compatibility matrix below
before deciding.

## Compatibility matrix

| `whatsapp-web.js` feature | OpenBSP support | Notes |
|---|---|---|
| Send text message | ✅ direct port | Bare E.164 instead of `chatId`. |
| Send media (image, video, audio, document, sticker) | ✅ direct port | Pass a public URL or upload to Storage first. |
| Receive messages | ✅ direct port | Via webhook instead of `client.on('message', ...)`. |
| Message replies (re_message_id) | ✅ direct port | Set `content.re_message_id`. |
| Reactions | ✅ direct port | Reaction is its own message kind. |
| Send location | ✅ direct port | `content.kind: "location"`. |
| Send contacts (vcard) | ✅ direct port | `content.kind: "contacts"`. |
| **First-touch outbound to a new contact** | ⚠️ templates only | Cloud API requires a pre-approved template to start a conversation outside the 24h window. `whatsapp-web.js` had no such constraint. |
| Send buttons / lists | ⚠️ templates only | `whatsapp-web.js` itself deprecated buttons/lists. OpenBSP supports them inside template messages. |
| Group: send to group | ✅ partial | OpenBSP can send to groups your business number is in. |
| **Group: create / add / kick / promote** | ❌ no equivalent | Cloud API does not expose group management. |
| **Communities** | ❌ no equivalent | Not in Cloud API. |
| **Channels** | ❌ no equivalent | Not in Cloud API. |
| **Polls** | ❌ no equivalent | Cloud API does not expose poll creation. |
| **Status messages** | ❌ no equivalent | Cloud API has no status/stories. |
| **Block / unblock contacts** | ❌ no equivalent | Not exposed by Cloud API. |
| **Profile pictures of arbitrary contacts** | ❌ no equivalent | Only your own business profile is queryable. |
| **Mute / unmute chats** | ❌ no equivalent | Chat-state controls aren't in Cloud API. |
| **Set user status (your bio)** | ❌ no equivalent | Cloud API doesn't expose this. |
| **"Last seen" / online status** | ❌ no equivalent | Cloud API doesn't expose presence. |
| Read receipts (mark as read) | ✅ direct port | OpenBSP fires the read-status update on outbound messages. |
| Typing indicators | ✅ partial | OpenBSP can send typing indicators on outbound replies. |
| Multi-device | ✅ natively | Cloud API isn't device-bound. |
| Authentication | session-restore via local files | API key, no QR code, no session loss. |

In short: **anything related to "what an individual WhatsApp user can do" is
gone**. Anything related to "what a business messages customers" is
supported, often with extra reliability.

## Account model: from personal QR pairing to WABA

### `whatsapp-web.js`
```js
const client = new Client({ authStrategy: new LocalAuth() });
client.on('qr', qr => qrcode.generate(qr));
client.on('ready', () => console.log('Ready'));
client.initialize();
```
You scan a QR code on your phone. Your personal WhatsApp account becomes
controllable from Node. Sessions can break; you may need to re-pair.

### OpenBSP
You go through Meta's **Embedded Signup** flow once, in the OpenBSP dashboard
([web.openbsp.dev](https://web.openbsp.dev) → Settings → WhatsApp). This:
- Verifies your business with Meta.
- Registers a WhatsApp Business Account (WABA).
- Assigns one or more phone numbers to that WABA.
- Returns a stable `phone_number_id` you'll use as the sender for every send
  call.

No QR code, no session expiry, no Puppeteer. Sender is a property of your
config, not a property of an in-memory client.

## Outbound messages

### Send a text message

**whatsapp-web.js**
```js
await client.sendMessage('5491155551234@c.us', 'Hello world');
```

**OpenBSP**
```http
POST https://nheelwshzbgenpavwhcy.supabase.co/rest/v1/messages
apikey: <publishable_key>
api-key: <openbsp_api_key>
Content-Type: application/json

{
  "organization_id": "<org uuid>",
  "organization_address": "<phone_number_id>",
  "contact_address": "5491155551234",
  "service": "whatsapp",
  "direction": "outgoing",
  "content": {
    "version": "1",
    "type": "text",
    "kind": "text",
    "text": "Hello world"
  }
}
```

Key differences:

- **No `@c.us` / `@g.us` suffix.** `contact_address` is bare E.164.
- **No in-memory `client`.** Sending is a stateless HTTP call.
- **Sender is `organization_address`.** It's Meta's `phone_number_id`, not the
  phone number you dialed; look it up once after onboarding and store it.
- **24-hour customer-service window applies** (see below). Sending to a
  contact who hasn't messaged you in the last 24h requires a template.

### Send media

**whatsapp-web.js**
```js
const media = MessageMedia.fromFilePath('./receipt.pdf');
await client.sendMessage('5491155551234@c.us', media, { caption: 'Here it is' });
```

**OpenBSP** (public URL — closest port)
```json
{
  "organization_id": "<uuid>",
  "organization_address": "<phone_number_id>",
  "contact_address": "5491155551234",
  "service": "whatsapp",
  "direction": "outgoing",
  "content": {
    "version": "1",
    "type": "file",
    "kind": "document",
    "file": {
      "mime_type": "application/pdf",
      "uri": "https://example.com/receipt.pdf",
      "name": "receipt.pdf",
      "size": 12345
    },
    "text": "Here it is"
  }
}
```

OpenBSP fetches the URL, uploads to Meta, and sends. If you don't want to host
the file publicly, upload to Supabase Storage first and reference
`internal://media/organizations/<org_id>/attachments/<hash>` instead. See
`MIGRATING_FROM_TWILIO.md` for the upload flow.

Pick `kind` explicitly: `image`, `video`, `audio`, `document`, `sticker`.

### Reply to a message

**whatsapp-web.js**
```js
client.on('message', async msg => {
  await msg.reply('Got it');
});
```

**OpenBSP**
```json
{
  ...,
  "content": {
    "version": "1",
    "type": "text",
    "kind": "text",
    "text": "Got it",
    "re_message_id": "<external_id of the message you're replying to>"
  }
}
```

`external_id` is the Meta WAMID, included on every inbound message via the
webhook. Save it from the inbound payload, pass it back on the reply.

### React to a message

**whatsapp-web.js**
```js
await msg.react('👍');
```

**OpenBSP**
```json
{
  ...,
  "content": {
    "version": "1",
    "type": "data",
    "kind": "reaction",
    "data": { "emoji": "👍" },
    "re_message_id": "<external_id>"
  }
}
```

### Send location

**whatsapp-web.js**
```js
await client.sendMessage(chatId, new Location(-34.6037, -58.3816, 'Buenos Aires'));
```

**OpenBSP**
```json
{
  ...,
  "content": {
    "version": "1",
    "type": "data",
    "kind": "location",
    "data": {
      "latitude": -34.6037,
      "longitude": -58.3816,
      "name": "Buenos Aires",
      "address": "Argentina"
    }
  }
}
```

## Receiving messages

### `whatsapp-web.js`
```js
client.on('message', async msg => {
  console.log(msg.from, msg.body, msg.hasMedia);
});
```

The event is fired by your long-running Node process. You handle it inline.

### OpenBSP

Register a webhook once per environment:

```http
POST /rest/v1/webhooks
{
  "table_name": "messages",
  "operations": ["insert"],
  "url": "https://your.app/openbsp/incoming",
  "token": "<shared secret>"
}
```

OpenBSP POSTs you JSON when a new message lands:

```json
{
  "entity": "messages",
  "action": "insert",
  "data": {
    "id": "<uuid>",
    "external_id": "<Meta WAMID>",
    "direction": "incoming",
    "service": "whatsapp",
    "organization_address": "<phone_number_id>",
    "contact_address": "5491155551234",
    "content": { "type": "text", "kind": "text", "text": "Hello" },
    "timestamp": "2026-05-20T12:34:56Z"
  }
}
```

Two things to know:

- **The webhook fires for both directions.** Filter `data.direction ===
  "incoming"` if you only want inbound.
- **No long-running process.** Your handler runs per-request. You don't need
  to keep a Chrome instance alive, restart on crashes, or persist a session.

## The big behavior change: 24-hour window + templates

The single largest semantic difference between `whatsapp-web.js` and the
Cloud API.

**With `whatsapp-web.js`** you can send any text to any number at any time —
you're behaving as a personal WhatsApp user, subject only to WhatsApp's
anti-spam heuristics.

**With OpenBSP** (Cloud API rules):

- If a contact has messaged your business in the last 24 hours, you can reply
  with free-form text/media. This is the "customer service window."
- After 24 hours of silence, you can only send **pre-approved template
  messages**. Templates are registered with Meta, reviewed (24–48 hours
  typically), and have a fixed structure with named variable placeholders.

This is the right behavior for business messaging (no spam) but it means **any
bot that proactively pings users will need templates**. Examples:

- Daily/weekly newsletters → template required.
- "Hey, are you still there?" follow-ups outside 24h → template required.
- Onboarding nudges hours after signup → template required.

If your `whatsapp-web.js` bot is purely reactive (only responds to inbound
within 24h), the migration is mostly free. If it initiates, plan template
registration into your migration work.

### Send a template

```json
{
  ...,
  "content": {
    "version": "1",
    "type": "data",
    "kind": "template",
    "data": {
      "name": "welcome_back",
      "language": { "code": "en_US" },
      "parameters": [
        { "type": "text", "text": "Acme" },
        { "type": "text", "text": "12 PM" }
      ]
    }
  }
}
```

Templates bypass the 24h window. Register them via the OpenBSP dashboard.

## Operational differences

| concern | `whatsapp-web.js` | OpenBSP |
|---|---|---|
| Runtime | Long-running Node process + Puppeteer + Chrome | Stateless HTTP calls |
| Memory footprint | ~300–500 MB for the Chrome instance | None on your side; OpenBSP runs on Supabase Edge Functions |
| Crash recovery | Resume session from disk; sometimes requires re-QR | Nothing to recover; next request just works |
| Multi-tenant | One Node process per WhatsApp account | One OpenBSP org per WABA; multi-tenant by default |
| Number portability | Tied to whichever phone scanned the QR | Tied to your WABA; survives infra changes |
| Ban risk | Real and documented | None — you're an authorized Meta BSP user |
| Per-message cost | Free (no Meta involvement) | Meta's conversation pricing; nothing on top from self-hosted OpenBSP, demo-tier quotas on hosted |
| Compliance | Grey area (violates WhatsApp ToS) | Fully sanctioned |

## When migrating makes sense

- You have a customer-service or transactional bot (reactive within 24h, or
  routine outbound through templates).
- You've been banned, fear being banned, or your bot has gone down due to
  WhatsApp updates breaking the Web client.
- You're scaling past one number and need multi-tenant infrastructure.
- You need predictable uptime and SLA-style behavior.

## When it doesn't

- You rely on group creation/management, polls, communities, channels, or
  user-account features (status, mute, block).
- Your use case is a personal-style assistant where the user is messaging
  *as themselves*, not as a business.
- You're not willing to register a WhatsApp Business Account with Meta (some
  jurisdictions require KYC).

For those cases, `whatsapp-web.js` remains the only practical option — at the
cost of the risks it carries.

## What this guide does not cover

- WABA onboarding via Embedded Signup (one-time UI flow in the OpenBSP
  dashboard).
- Template authoring and approval.
- Migrating saved sessions / contact lists from `whatsapp-web.js`'s local
  store. OpenBSP doesn't import them; contacts populate naturally as inbound
  messages arrive.
- OpenBSP features without a `whatsapp-web.js` equivalent (AI agents,
  conversation pause, internal-direction messages, the MCP server). See the
  main README.

## Cheat sheet

| If you do this in `whatsapp-web.js` | …do this in OpenBSP |
|---|---|
| `new Client(...).initialize()` + QR scan | One-time Embedded Signup in the dashboard, then nothing |
| `client.sendMessage('NUM@c.us', body)` | `POST /rest/v1/messages` with `contact_address`, `content.text` |
| `MessageMedia.fromFilePath(...)` | `content.type: "file"`, pass a public URL or `internal://` Storage URI |
| `msg.reply(text)` | set `content.re_message_id` to the inbound's `external_id` |
| `msg.react(emoji)` | `content.kind: "reaction"`, `data.emoji`, `re_message_id` |
| `client.on('message', fn)` | one row in `webhooks` table with `operations: ["insert"]` |
| `client.getChats()` / `getContactById()` | `GET /rest/v1/conversations`, `/contacts` over PostgREST |
| Group create / add / remove | **No equivalent** — Cloud API doesn't expose group management |
| Polls / Communities / Channels / Status | **No equivalent** — Cloud API doesn't expose them |
| First-touch message to any number | Register and send a template instead |
| Re-pair after session loss | Doesn't happen; sessions don't exist |
