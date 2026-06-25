# Tech Provider as a Service

Ship a WhatsApp (or Instagram) product **without registering with Meta as a Tech
Provider**. Your customers connect their own WhatsApp Business accounts _under
OpenBSP's_ Meta app via Embedded Signup; from then on you drive everything over
a plain REST API with an API key, and — if you want — that account's message
webhooks are delivered **straight to your app**.

OpenBSP is the Tech Provider. You are its API consumer. No Meta app review, no
business verification, no JS SDK on your side.

```
your customer ──(onboarding link)──► OpenBSP Embedded Signup ──► WABA connected
                                                                      │
your app ◄── messages (per-account webhook) ── Meta Cloud API ◄───────┘
your app ◄── account events / logs (OpenBSP webhooks or polling) ── OpenBSP
your app ──► send (OpenBSP REST  *or*  Meta directly with the account token)
```

There is exactly **one thing you do in the dashboard** — create your org and an
API key. Everything else is REST.

---

## Conventions

- **Base URL:** `https://nheelwshzbgenpavwhcy.supabase.co`
- **Dashboard:** `https://web.openbsp.dev`
- Every REST call sends **two** headers:

  ```
  apikey: <PUBLISHABLE_KEY>     # public Supabase publishable key (it's in the web bundle)
  api-key: <OPENBSP_API_KEY>    # the secret key you generate below
  ```

  Do **not** send `Authorization: Bearer <api-key>` — PostgREST would reject it
  as a non-JWT. See [AUTH.md](AUTH.md) for the full model.

---

## 1. Create your organization (dashboard, one-time)

Sign in at [web.openbsp.dev](https://web.openbsp.dev) with Google or GitHub.
Your organization is created on first sign-in.

> This is the **only** step that needs a logged-in user — creating an
> organization (and your owner membership) is the one operation an API key can't
> do. After this you never need the UI again.

## 2. Generate an API key

Dashboard → **Settings → API Keys → New**. Pick a role:

- **owner** — full access, including minting onboarding links.
- **admin** — manage templates, contacts, webhooks, send messages.
- **member** — read + send.

Copy the key. It's scoped to this one organization and carries that role.

## 3. Make REST calls

PostgREST is exposed at `/rest/v1/<table>`; edge functions at
`/functions/v1/<function>`. A couple of reads:

```bash
# Connected accounts (phone numbers) in your org
curl 'https://nheelwshzbgenpavwhcy.supabase.co/rest/v1/organizations_addresses?service=eq.whatsapp&select=address,status,extra' \
  -H 'apikey: <PUBLISHABLE_KEY>' -H 'api-key: <OPENBSP_API_KEY>'

# Recent platform/Meta events for your org (account updates, signup/history errors)
curl 'https://nheelwshzbgenpavwhcy.supabase.co/rest/v1/logs?select=level,category,service,message,metadata,created_at&order=created_at.desc&limit=20' \
  -H 'apikey: <PUBLISHABLE_KEY>' -H 'api-key: <OPENBSP_API_KEY>'
```

## 4. (Optional) Register webhooks instead of polling

So your app is _pushed_ events. Dashboard → **Settings → Webhooks → New**, or
via REST:

```bash
curl -X POST 'https://nheelwshzbgenpavwhcy.supabase.co/rest/v1/webhooks' \
  -H 'apikey: <PUBLISHABLE_KEY>' -H 'api-key: <OPENBSP_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "table_name": "organizations_addresses",
    "operations": ["insert", "update"],
    "url": "https://your-app.com/openbsp/accounts",
    "token": "<your shared secret>"
  }'
```

Subscribable tables: `organizations_addresses` (account connected / disconnected
— **the payload includes the account access token**), `logs` (Meta events &
errors), `contacts`, `contacts_addresses`, plus `messages` / `conversations`
(the latter two only carry data for accounts _not_ using a per-account webhook —
see step 7). OpenBSP `POST`s `{ entity, action, data: <row> }` to your `url`,
with `Authorization: Bearer <token>` if you set one.

## 5. Mint an onboarding link (API key)

This is how you hand a customer a link to connect their WhatsApp. Create an
`onboarding_token` — and, if you want their traffic delivered to **your** app,
set `callback_url` + `verify_token` (the per-account webhook override):

```bash
curl -X POST 'https://nheelwshzbgenpavwhcy.supabase.co/rest/v1/onboarding_tokens?select=id' \
  -H 'apikey: <PUBLISHABLE_KEY>' -H 'api-key: <OWNER_OPENBSP_API_KEY>' \
  -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
  -d '{
    "name": "Acme Corp",
    "service": "whatsapp",
    "expires_at": "2026-07-01T00:00:00Z",
    "callback_url": "https://your-app.com/acme/whatsapp",
    "verify_token": "a-long-random-secret"
  }'
```

Minting requires an **owner** API key. The response `id` is the link token; hand
the customer:

```
https://web.openbsp.dev/onboard/whatsapp/<id>
```

(`callback_url`/`verify_token` are optional — omit them to keep messages flowing
through OpenBSP instead.)

## 6. The customer connects

They open the link and complete Embedded Signup (no OpenBSP account, no Meta
developer setup needed). On success:

- the onboarding token flips to `used`;
- a row appears in `organizations_addresses` (`status = connected`) whose
  `extra` holds `waba_id`, `phone_number`, and the **`access_token`**;
- if you set a `callback_url`, that WABA's message webhooks are pointed at it.

You learn about it via your `organizations_addresses` webhook (step 4) or by
polling (step 8).

## 7. Receive messages and send

**Receiving** — with a `callback_url` set, Meta delivers that account's incoming
messages and statuses **directly to your app's URL** (verified with your
`verify_token`). Account-level events (connect/disconnect, errors) still come
from OpenBSP via the `organizations_addresses` / `logs` channels. OpenBSP does
**not** store these messages.

**Sending** — two options:

- **Through OpenBSP** (simplest): `POST /rest/v1/messages` with the
  `organization_address` (the `phone_number_id`), `contact_address`, and a
  `content` object. See [MIGRATING_FROM_TWILIO.md](MIGRATING_FROM_TWILIO.md) for
  the message shapes.
- **Directly to Meta** (fully autonomous): read `extra.access_token` from
  `organizations_addresses` and call the WhatsApp Cloud API yourself.

## 8. (Optional) Poll instead of webhooks

If you'd rather pull than receive pushes:

```bash
# Has the account connected yet?
curl 'https://nheelwshzbgenpavwhcy.supabase.co/rest/v1/organizations_addresses?service=eq.whatsapp&status=eq.connected&select=address,extra,updated_at' \
  -H 'apikey: <PUBLISHABLE_KEY>' -H 'api-key: <OPENBSP_API_KEY>'

# Any onboarding/Meta errors?
curl 'https://nheelwshzbgenpavwhcy.supabase.co/rest/v1/logs?level=eq.error&select=category,service,message,metadata,created_at&order=created_at.desc' \
  -H 'apikey: <PUBLISHABLE_KEY>' -H 'api-key: <OPENBSP_API_KEY>'
```

---

## Recap

1. Create your org + API key in the dashboard (once).
2. (Optional) Register `organizations_addresses` + `logs` webhooks.
3. Mint an onboarding link (with `callback_url`/`verify_token`) via the API.
4. Customer connects → account appears in `organizations_addresses` with its
   token.
5. Their messages arrive at your `callback_url`; you send via OpenBSP or Meta.

You shipped a multi-tenant WhatsApp product and never touched Meta's Tech
Provider program — OpenBSP is the Tech Provider, as a service.
