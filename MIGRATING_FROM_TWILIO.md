# Migrating from Twilio (WhatsApp) to OpenBSP

This guide is for teams already running WhatsApp through Twilio's Programmable
Messaging API who want to swap in OpenBSP — either the hosted instance at
[web.openbsp.dev](https://web.openbsp.dev) or a self-host.

Scope: WhatsApp only. Audience: developers comfortable with HTTP and JSON.

## Cheat sheet

| In Twilio you do this | In OpenBSP you do this |
|---|---|
| `POST /Messages.json` with `From`, `To`, `Body` | `POST /rest/v1/messages` with `organization_address`, `contact_address`, `content.text` |
| `whatsapp:+E164` everywhere | bare E.164, set `service: "whatsapp"` once |
| `MediaUrl` field | `content.type: "file"`, pass the public URL in `content.file.uri` |
| `ContentSid` + `ContentVariables` | `content.kind: "template"` + `data: { name, language, parameters }` (templates must be re-registered with Meta) |
| `StatusCallback` per message | one row in `webhooks` table, fires for every status update |
| Per-number inbound webhook in Twilio console | one row in `webhooks` table with `operations: ["insert"]` |
| `MessageSid` (`SM…`) | `messages.id` (uuid) or `external_id` (the Meta WAMID) |
| Twilio number purchase | Embedded Signup to attach your existing WhatsApp Business number |
| HTTP Basic auth | `apikey` + `api-key` headers |

## Authentication

Twilio: HTTP Basic on every call, `AccountSid` as username, `AuthToken` as
password.

OpenBSP: two headers on every call.

```http
apikey: <Supabase publishable key>
api-key: <OpenBSP API key>
```

The `apikey` is public (embedded in the OpenBSP web bundle). The `api-key` is
your secret — generated in the OpenBSP dashboard under **Settings > API Keys**
and scoped to a single organization.

Both required, both sent on every request.

## Send a text message

### Twilio

```http
POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
Authorization: Basic base64(AccountSid:AuthToken)
Content-Type: application/x-www-form-urlencoded

From=whatsapp:%2B14155238886
To=whatsapp:%2B5491155551234
Body=Hello%20world
```

### OpenBSP

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

Three things change:

- **Drop the `whatsapp:+` prefix.** `contact_address` is bare E.164 (no `+`).
- **`From` becomes `organization_address`.** It's Meta's `phone_number_id` for
  the WhatsApp Business number you connected (e.g. `123456789012345`), not the
  phone number itself. Look it up once after onboarding and treat it as stable.
- **`Body` becomes nested `content`.** Verbose, but the same column holds text,
  media, and templates without polymorphism at the row level.

Response shape (PostgREST defaults to returning the inserted row when
`Prefer: return=representation` is set):

```json
{
  "id": "9f4a…",                      // OpenBSP's stable message id (uuid)
  "external_id": null,                // populated once Meta accepts the message (WAMID)
  "status": { "pending": "2026-05-20T12:34:56Z" },
  ...
}
```

## Send a media message

### Twilio

```http
POST /Messages.json
From=whatsapp:%2B14155238886
To=whatsapp:%2B5491155551234
Body=Here's%20the%20receipt
MediaUrl=https://example.com/receipt.pdf
```

### OpenBSP — pass a public URL through

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
    "text": "Here's the receipt"
  }
}
```

OpenBSP fetches the URL, uploads to Meta, and dispatches — same as Twilio.

### OpenBSP — upload once, reference internally

If the bytes are local, you can upload to OpenBSP's Storage first and skip the
public-URL hop:

```http
POST {SUPABASE_URL}/storage/v1/object/media/organizations/<org_id>/attachments/<hash>
```

then set:

```json
"file": { "uri": "internal://media/organizations/<org_id>/attachments/<hash>", ... }
```

Twilio has no equivalent — `MediaUrl` always means "fetch this URL." Both
options exist in OpenBSP, public URL is the literal port.

### Pick the right `kind`

Twilio infers the WhatsApp message type from the media MIME. OpenBSP is
explicit. Valid values:

- `image` — `image/jpeg`, `image/png`, `image/webp`
- `video` — `video/mp4`, `video/3gpp`
- `audio` — `audio/aac`, `audio/mp4`, `audio/mpeg`, `audio/amr`, `audio/ogg`
- `document` — PDFs, Office files, etc.
- `sticker` — `image/webp`

## Send a template message

### Twilio

```http
POST /Messages.json
From=whatsapp:%2B14155238886
To=whatsapp:%2B5491155551234
ContentSid=HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ContentVariables=%7B%221%22%3A%22Acme%22%2C%222%22%3A%22%2450%22%7D
```

### OpenBSP

```json
{
  "organization_id": "<uuid>",
  "organization_address": "<phone_number_id>",
  "contact_address": "5491155551234",
  "service": "whatsapp",
  "direction": "outgoing",
  "content": {
    "version": "1",
    "type": "data",
    "kind": "template",
    "data": {
      "name": "order_confirmation",
      "language": { "code": "en_US" },
      "parameters": [
        { "type": "text", "text": "Acme" },
        { "type": "text", "text": "$50" }
      ]
    }
  }
}
```

> [!IMPORTANT]
> Twilio templates are registered with Twilio (and proxied to Meta under
> Twilio's WABA). OpenBSP templates are registered directly with Meta under
> your own WABA. **You cannot port `ContentSid` values** — re-create each
> template against your Meta account, get new names, and update your code.
> This is unavoidable when moving off Twilio to any direct-Meta BSP.

Templates bypass the 24-hour customer-service window in both Twilio and
OpenBSP.

## Status callbacks (delivery state)

### Twilio
Per-message `StatusCallback` URL. Twilio POSTs `MessageStatus` updates keyed by
`MessageSid` as the message moves through `queued → sent → delivered → read`
(or `failed` / `undelivered`).

### OpenBSP
Status updates land on the same `messages` row's `status` JSONB column:

```json
"status": {
  "accepted":  "2026-05-20T12:34:56Z",
  "sent":      "2026-05-20T12:34:57Z",
  "delivered": "2026-05-20T12:35:02Z",
  "read":      "2026-05-20T12:36:11Z"
}
```

Two ways to consume them:

**Polling** (one-off):
```http
GET /rest/v1/messages?id=eq.<id>&select=status
```

**Push** (recommended for parity with Twilio's `StatusCallback`):
register one webhook once:

```http
POST /rest/v1/webhooks
{
  "table_name": "messages",
  "operations": ["update"],
  "url": "https://your.app/openbsp/status",
  "token": "<your shared secret>"
}
```

OpenBSP POSTs you `{ entity, action, data: <MessageRow> }` on every status
change. Correlate by `id` (the OpenBSP uuid) or `external_id` (Meta's WAMID,
analogous to `MessageSid`).

One registration replaces the per-send `StatusCallback` URL.

## Inbound webhook (receiving messages)

### Twilio
Configure a webhook URL per WhatsApp number in the Twilio console. Twilio
POSTs form-encoded payloads:

```
MessageSid=SMxxx
From=whatsapp:+5491155551234
To=whatsapp:+14155238886
Body=Reply text
NumMedia=1
MediaUrl0=https://api.twilio.com/.../Media/MExxx
MediaContentType0=image/jpeg
ProfileName=Customer Name
WaId=5491155551234
```

You return `200 OK` (optionally with TwiML XML to auto-reply).

### OpenBSP
Same `webhooks` table as for status callbacks, with `operations: ["insert"]`.
Payload is JSON, not form-urlencoded:

```json
{
  "entity": "messages",
  "action": "insert",
  "data": {
    "id": "<uuid>",
    "direction": "incoming",
    "service": "whatsapp",
    "organization_address": "<phone_number_id>",
    "contact_address": "5491155551234",
    "content": { "type": "text", "kind": "text", "text": "..." },
    "timestamp": "2026-05-20T12:34:56Z"
  }
}
```

Two things to know:

- **`messages` mixes both directions.** Filter on `data.direction === "incoming"`
  in your handler if you only want inbound (the webhook fires for outgoing
  inserts too).
- **No TwiML.** OpenBSP doesn't have a synchronous-reply mechanism. To reply,
  POST a new outgoing message to `/rest/v1/messages` from your handler — same
  shape as any other send.

## Errors and retries

### Twilio
HTTP status + numeric `code` in the response body. Examples: `21610` (user not
allowed to message), `63016` (outside 24h window), `21408` (no Twilio number
permission).

### OpenBSP
Errors land in two places.

**Synchronous** — HTTP 4xx on the `POST /rest/v1/messages` if the request shape
is invalid (bad content kind, missing required fields, RLS rejects the org).

**Async** — Meta's errors land on the `messages` row's `status`:

```json
"status": {
  "failed": "2026-05-20T12:34:57Z",
  "errors": [
    { "code": 131047, "title": "Re-engagement message", "message": "..." }
  ]
}
```

You receive these via the same status-update webhook.

Map your error-code handling: Twilio `63016` (outside window) → Meta `131047`.
If your code switches on Twilio error codes, you'll need a translation table.

## Sender setup

Twilio: buy a WhatsApp-enabled number from Twilio (or use the sandbox for
testing).

OpenBSP: connect your *existing* WhatsApp Business Account via Meta's Embedded
Signup. The number stays yours; you're not renting from a provider. One-time UI
flow in the OpenBSP dashboard. After it completes, your `organization_address`
is the Meta `phone_number_id` of the connected number.

Send-side code doesn't change once the number is connected.

## What this guide does not cover

- **Programmatic template registration.** OpenBSP exposes Meta's Content
  Management API at `/functions/v1/whatsapp-management/templates` — see the
  OpenAPI spec. The dashboard handles this in the UI for most teams.
- **OpenBSP-specific features without a Twilio equivalent**: AI agents,
  conversation pause, internal-direction messages, multi-tenant org isolation,
  service-window helpers. See the main README.
- **Inbound media download.** Twilio hosts inbound media on its servers behind
  Basic auth. OpenBSP downloads it from Meta and stores it in Supabase
  Storage; the `content.file.uri` in the webhook payload points to a signed
  Storage URL.

## A note on cost

The reason most teams migrate from Twilio to a direct-Meta BSP is pricing.
Twilio adds a per-message markup on top of Meta's conversation pricing.
OpenBSP's hosted instance has a quota-based plan and the self-hosted route
charges you Meta's prices directly plus your Supabase bill. Either way you skip
Twilio's per-message margin.

If your monthly Twilio bill is dominated by message volume rather than support
or features, the migration usually pays back inside the first invoice cycle.
