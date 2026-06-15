# Using n8n with OpenBSP

You can send and receive WhatsApp messages through OpenBSP using nothing but
n8n's two built-in generic HTTP nodes — **no custom node or community package is
required**:

- **HTTP Request** node → _send_ messages by inserting rows into the OpenBSP
  REST API.
- **Webhook** node → _receive_ incoming messages and status updates that OpenBSP
  pushes to you.

```
              send  ┌───────────────────────────────┐
n8n HTTP Request ──▶│ POST /rest/v1/messages         │  OpenBSP
                    └───────────────────────────────┘  (Supabase
                                                        PostgREST
              receive ┌─────────────────────────────┐  + triggers)
n8n Webhook ◀──────── │ webhook trigger → HTTP POST  │
                      └─────────────────────────────┘
```

For the underlying authentication model, see [`AUTH.md`](AUTH.md). For the
project overview, see [`README.md`](README.md).

## Prerequisites

| What you need                | Where it comes from                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **OpenBSP API key**          | Settings → API Keys in the OpenBSP UI. Sent in the `api-key` header.                                                           |
| **Supabase publishable key** | The project's anon/publishable key (`sb_publishable_...`). Sent in the `apikey` header.                                        |
| **Base URL**                 | `https://<PROJECT_REF>.supabase.co` — e.g. PROD is `https://nheelwshzbgenpavwhcy.supabase.co`. Self-hosters use their own URL. |
| **`organization_address`**   | Your WhatsApp **phone number ID**. Find it via `GET /rest/v1/organizations_addresses` (field `address`).                       |
| **`organization_id`**        | The OpenBSP organization UUID (needed when registering a webhook). Same endpoint returns `organization_id`.                    |

> Throughout this guide, replace `<PROJECT_REF>`, `<OPENBSP_API_KEY>`,
> `<PUBLISHABLE_KEY>`, `<org-uuid>`, and `<phone_number_id>` with your own
> values.

---

## 1. Sending messages — HTTP Request node

Sending a message is simply an insert into the `messages` table over PostgREST.

**Node settings**

- **Method:** `POST`
- **URL:** `https://<PROJECT_REF>.supabase.co/rest/v1/messages`
- **Headers:**

  | Header         | Value                   |
  | -------------- | ----------------------- |
  | `apikey`       | `<PUBLISHABLE_KEY>`     |
  | `api-key`      | `<OPENBSP_API_KEY>`     |
  | `Content-Type` | `application/json`      |
  | `Prefer`       | `return=representation` |

  `Prefer: return=representation` makes PostgREST return the inserted row (its
  `id` and initial `status`) so downstream nodes can use it.

> ⚠️ **Do not** set `Authorization: Bearer <OPENBSP_API_KEY>`. The OpenBSP key
> is not a JWT, and PostgREST rejects the request with `401 PGRST301` before any
> SQL runs. The OpenBSP key only ever goes in the `api-key` header for REST
> calls. (See the test table in [`AUTH.md`](AUTH.md).)

**Body skeleton** (JSON):

```json
{
  "organization_address": "<phone_number_id>",
  "contact_address": "<recipient phone, digits only, e.g. 5491155551234>",
  "service": "whatsapp",
  "direction": "outgoing",
  "content": {
    /* one of the content objects below */
  }
}
```

### Content examples

**Text**

```json
"content": {
  "version": "1",
  "type": "text",
  "kind": "text",
  "text": "Hello from n8n!"
}
```

**Image / document** (any media — `kind` is one of `image`, `document`, `audio`,
`video`, `sticker`):

```json
"content": {
  "version": "1",
  "type": "file",
  "kind": "document",
  "file": {
    "uri": "https://example.com/report.pdf",
    "mime_type": "application/pdf",
    "name": "report.pdf",
    "size": 1024000
  },
  "text": "Optional caption"
}
```

A `uri` starting with `http(s)://` is forwarded to WhatsApp as a link, so the
file must be publicly reachable. Media size limits (enforced by WhatsApp): image
5 MB, audio 16 MB, video 16 MB, document 100 MB, sticker 100 KB (static) / 500
KB (animated).

**Template** (required to start a conversation outside the 24-hour service
window):

```json
"content": {
  "version": "1",
  "type": "data",
  "kind": "template",
  "data": {
    "name": "hello_world",
    "language": { "code": "en_US" },
    "components": [
      {
        "type": "body",
        "parameters": [{ "type": "text", "text": "John" }]
      }
    ]
  }
}
```

Outgoing messages also support `kind: "location"` and `kind: "contacts"`
(`type: "data"`). See the type definitions in
[`supabase/functions/_shared/types/message_types.ts`](supabase/functions/_shared/types/message_types.ts)
(`OutgoingMessage`).

### Using values from earlier nodes

Populate the body from upstream data with n8n expressions, e.g.:

```json
{
  "organization_address": "<phone_number_id>",
  "contact_address": "={{ $json.from }}",
  "service": "whatsapp",
  "direction": "outgoing",
  "content": {
    "version": "1",
    "type": "text",
    "kind": "text",
    "text": "={{ 'You said: ' + $json.text }}"
  }
}
```

### Tracking delivery

The insert returns immediately with `status: { "pending": "<timestamp>" }`. The
message then progresses through `accepted → sent → delivered → read`, or
`failed`. To check later, poll:

```
GET /rest/v1/messages?id=eq.<id>&select=status
```

(with the same `apikey` + `api-key` headers). Or, better, subscribe to status
updates via a webhook — see the next section.

---

## 2. Receiving messages — Webhook node

OpenBSP fires an outbound HTTP POST whenever a row in `messages` or
`conversations` is inserted or updated, to every webhook URL you have registered
for that organization. This is driven by the `notify_webhook()` trigger
([`supabase/schemas/02_functions/02-03_trigger_functions.sql`](supabase/schemas/02_functions/02-03_trigger_functions.sql)).

### Step A — create the n8n Webhook node

Add a **Webhook** trigger node, set its HTTP method to `POST`, and copy its
**Production URL**. (Use the Test URL while building.)

### Step B — register the webhook in OpenBSP

Insert a row into the `webhooks` table over REST (one-time setup — do it with
the n8n HTTP Request node, `curl`, or any client):

```
POST https://<PROJECT_REF>.supabase.co/rest/v1/webhooks
```

Headers: same `apikey` + `api-key` + `Content-Type: application/json` as above.

Body:

```json
{
  "organization_id": "<org-uuid>",
  "table_name": "messages",
  "operations": ["insert"],
  "url": "<your n8n production webhook URL>",
  "token": "<optional shared secret>"
}
```

| Field        | Allowed values                                                    |
| ------------ | ----------------------------------------------------------------- |
| `table_name` | `"messages"` or `"conversations"`                                 |
| `operations` | array of `"insert"` and/or `"update"`                             |
| `url`        | your n8n webhook URL                                              |
| `token`      | optional — if set, OpenBSP sends it as a bearer token (see below) |

Use `operations: ["insert"]` to receive new messages, or `["insert", "update"]`
to also receive status changes (`sent`, `delivered`, `read`, `failed`).

> **Constraints:**
>
> - Managing webhooks requires **admin** role on the organization (RLS in
>   [`supabase/schemas/05_rls/05-07_webhooks_rls.sql`](supabase/schemas/05_rls/05-07_webhooks_rls.sql)).
> - The trigger fans out to **at most 3** webhooks per organization per
>   table/operation (`limit 3` in `notify_webhook`).

### Payload n8n receives

Each event is a POST with this body:

```json
{ "data": {/* the full row */}, "entity": "messages", "action": "insert" }
```

Concrete example for an incoming text message:

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "organization_id": "<org-uuid>",
    "conversation_id": "<conv-uuid>",
    "service": "whatsapp",
    "organization_address": "<phone_number_id>",
    "contact_address": "5491155551234",
    "direction": "incoming",
    "content": {
      "version": "1",
      "type": "text",
      "kind": "text",
      "text": "Hello from WhatsApp"
    },
    "status": { "pending": "2026-06-03T10:00:00Z" },
    "timestamp": "2026-06-03T10:00:00Z",
    "created_at": "2026-06-03T10:00:00Z",
    "updated_at": "2026-06-03T10:00:00Z"
  },
  "entity": "messages",
  "action": "insert"
}
```

In n8n, the message text is at `{{ $json.body.data.content.text }}` and the
sender at `{{ $json.body.data.contact_address }}`.

### Verifying the request

If you set a `token` when registering the webhook, OpenBSP sends it as:

```
Authorization: Bearer <token>
```

Validate it in the n8n Webhook node by adding a **Header Auth** credential. If
no `token` is set, no `Authorization` header is sent.

> OpenBSP does **not** sign these outbound webhooks (no HMAC). The bearer
> `token` is the shared secret — treat it accordingly and prefer HTTPS. (This is
> separate from the Meta → OpenBSP inbound webhook, which OpenBSP verifies with
> `X-Hub-Signature-256`; that flow is internal and not relevant to n8n.)

### Filtering events

Because the webhook fires for **both** directions and for status updates, add an
**IF** (or **Filter**) node right after the Webhook node so your workflow only
reacts to genuinely new inbound messages:

- `{{ $json.body.data.direction }}` equals `incoming`
- optionally `{{ $json.body.action }}` equals `insert`

---

## 3. End-to-end example: an echo bot

1. **Webhook** node (`POST`, registered with `table_name: "messages"`,
   `operations: ["insert"]`).
2. **IF** node: continue only when
   `{{ $json.body.data.direction }} === "incoming"`.
3. **HTTP Request** node: `POST /rest/v1/messages` echoing the text back:

   ```json
   {
     "organization_address": "<phone_number_id>",
     "contact_address": "={{ $json.body.data.contact_address }}",
     "service": "whatsapp",
     "direction": "outgoing",
     "content": {
       "version": "1",
       "type": "text",
       "kind": "text",
       "text": "={{ 'You said: ' + $json.body.data.content.text }}"
     }
   }
   ```

Every inbound WhatsApp message is now echoed back to its sender.

---

## 4. Troubleshooting

| Symptom                            | Likely cause / fix                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 PGRST301` on send             | An `Authorization` header is set. Remove it — the OpenBSP key goes in `api-key` only (see §1 callout).                                                    |
| `403` / row-level security error   | The `api-key` lacks access to that organization, or (for webhooks) the key isn't **admin**.                                                               |
| Webhook never fires                | Check: the `webhooks` row exists for the right `organization_id`, `operations` includes the event you expect, and you haven't exceeded the 3-webhook cap. |
| Receiving duplicate-looking events | You subscribed to `update` too — filter on `action`/`direction` (see §2 filtering).                                                                       |
| Self-hosting                       | Replace `nheelwshzbgenpavwhcy` with your own project ref / Supabase URL everywhere.                                                                       |
