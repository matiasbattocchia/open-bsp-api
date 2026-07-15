# whatsmeow as a self-hosted channel — design notes (experiment)

> **Implementation status (2026-07-14)**: all landed in the working tree.
> Migration `20260714131915` (enum 'whatsapp-web' + contacts_addresses PK incl.
> service), `generic-webhook/` + `generic-dispatcher/` functions (the
> `whatsapp-web-webhook` / `whatsapp-web-dispatcher` slugs are config.toml
> entries pointing at the generic entrypoints; the code derives the service from
> the slug and reads `<SERVICE>_URL` / `<SERVICE>_TOKEN` env vars),
> `whatsapp-web-management`, and the `~/open-bsp-whatsmeow` Go bridge scaffold
> (compiles; text/receipts/pairing done, media/history/group-metadata TODO).
> Webhook + dispatcher verified end-to-end against the local stack.

Date: 2026-07-14. whatsmeow cloned (untracked) at `~/whatsmeow`
(`go.mau.fi/whatsmeow`, MPL-2.0, Go 1.25, last commit 2026-07-13 — actively
maintained).

## Architecture (settled)

The bridge is a plain **API client** of OpenBSP — it talks to three edge
functions and touches nothing else:

```
                    ┌──────────────── OpenBSP (Supabase) ────────────────┐
whatsmeow-bridge ──►│ generic webhook     (inbound msgs, media, contacts)│
 (Go, stateless) ◄──│ generic dispatcher  (outbound msgs, via trigger)   │
                 ◄─►│ whatsapp-web-management (pairing, sessions, lifecycle)│
                    │ Postgres: lends a `whatsmeow` schema for sessions  │
                    └────────────────────────────────────────────────────┘
```

- **DB lending**: whatsmeow's session store (`store/sqlstore`, Postgres dialect)
  lives in its own `whatsmeow` schema in the hosted Postgres. OpenBSP never
  reads or writes it; the library migrates it itself (`container.Upgrade()`).
  The bridge role owns that schema and has **zero grants on `public.*`**. (It
  could even be a separate Postgres — the coupling is purely "hosting".)
- **Generic webhook + dispatcher**: normally a `*-webhook`/`*-dispatcher` pair
  adapts OpenBSP to an external API's dialect (Meta Graph). The generic pair
  inverts this — the **connector adapts to OpenBSP's native contract** (v1
  `Part` content, `external_id`, address fields). Reusable by any future
  connector (Slack bridge, other unofficial WhatsApp libs, user-built).
- **Management stays service-specific** (`whatsapp-web-management`). Could later
  be generalized for other unofficial-WhatsApp integrations (QR pairing is a
  common shape) — deliberately not now.

## What whatsmeow is (and isn't)

- A **Go library**, not a runnable server. Speaks the WhatsApp Web multidevice
  protocol directly over WebSocket (no Chrome/puppeteer, no emulator).
  Self-hosters must run a wrapper binary — hence the bridge.
- Session store: SQLite or Postgres, self-managed `whatsmeow_*` tables. One
  `Container` holds many sessions (`GetAllDevices`/`GetDevice(jid)`) — one
  bridge instance serves many orgs/numbers.
- Login: QR channel (`Client.GetQRChannel`) or pairing code (`Client.PairPhone`)
  — no Meta app, no templates, no 24-hour window. Unofficial-channel caveats per
  `MIGRATING_FROM_WHATSAPP_WEB_JS.md`.
- Covers all protocol work `whatsapp-webhook` does via Graph API: media
  download+decrypt (`Client.DownloadAny` — media is E2E-encrypted here),
  receipts (`events.Receipt`), phone-sent echoes (`Info.IsFromMe`,
  multidevice-native), edits/revokes, pushnames/avatars
  (`GetProfilePictureInfo`), history (`events.HistorySync`), read/typing out
  (`MarkRead`, `SendChatPresence`), sending (`SendMessage`, `Upload`). The
  bridge is an event loop translating typed events ↔ OpenBSP payloads.

### Ready-made wrappers (rejected for primary path)

wuzapi (asternic/wuzapi) and GOWA (aldinokemal/go-whatsapp-web-multidevice) are
maintained REST wrappers with Docker + webhooks, but their payload dialects
aren't ours — we'd write an adapter anyway. A thin custom bridge speaks the
generic contract natively. Keep them as documented fallbacks.

## The pieces

### 1. Service enum

`alter type public.service add value if not exists 'whatsapp-web';` —
hand-written `ADD VALUE` migration per the CLAUDE.md enum rule (same pattern as
`20260629140839_slack_discord_teams_threads.sql`).

### 2. Generic dispatcher (outbound)

The trigger routes by naming convention —
`supabase/schemas/02_functions/02-02_edge_functions.sql:6-7`,
`path := '/' || service || '-dispatcher'` — so the generic implementation lives
in `functions/generic-dispatcher/` and each connector service is a config.toml
block whose slug matches the enum value but whose entrypoint is the generic
file; the code derives the service from the slug and reads `<SERVICE>_URL` /
`<SERVICE>_TOKEN` env vars (no trigger changes, no wrapper dirs). Behavior:

- Auth in: service-role bearer (same as `whatsapp-dispatcher`),
  `verify_jwt
  = false` in `config.toml`.
- Looks up the connector's URL + token (per-org in
  `organizations_addresses.extra`, or shared in Vault) and **forwards the
  standard `WebhookPayload<MessageRow>` as-is** — no translation; the connector
  understands OpenBSP's native row/Part format.
- For `FilePart`s, embeds a `createSignedUrl()` download link for the
  `internal://media/...` object so the connector fetches bytes with plain GET.
- Connector responds with `external_id` (+ status) → `commitDispatchedMessage`
  (`_shared/dispatch.ts`), which already handles the webhook-race 23505.
- Also receives the mark-as-read/typing trigger events and forwards them.

### 3. Generic webhook (inbound)

New edge function (working name `connector-webhook`; also a `_shared/` core if
per-service slugs are ever wanted). The connector POSTs OpenBSP-native payloads
— this is the inverse of `whatsapp-webhook`, which parses Meta's envelope:

- Auth: per-connector bearer/HMAC token (registered alongside the connector; in
  `extra` or Vault). `verify_jwt = false`.
- `POST /messages` — body is essentially rows for `public.messages`: v1
  `TextPart`/`FilePart`/`DataPart` content (`_shared/types/message_types.ts`),
  `external_id`, `direction`, `contact_address`, `organization_address`,
  `group_address`, `service`, `timestamp`. The function does the same
  server-side work as `whatsapp-webhook`: upsert on `external_id` (status-merge
  for delivered/read receipts on outgoing rows), edits/revokes, `logs` entries.
  Conversation auto-creation stays free via `before_insert_on_messages`
  (`02-03_trigger_functions.sql:142`).
- `POST /contacts` — upsert `contacts_addresses` (names, avatars) on
  `(organization_id, address)`.
- `POST /media` — multipart bytes → `uploadToStorage()` (reuse
  `_shared/media.ts`, incl. `MAX_STORAGE_UPLOAD_SIZE`) → returns the
  `internal://media/...` URI, which the connector then references in a
  subsequent `/messages` post. The webhook holds the service key, so no signed
  URLs / S3 creds / storage creds in the connector.

### 4. whatsapp-web-management (service-specific)

Mirrors `whatsapp-management`/`instagram-management` (Hono, role checks; no
templates concern). The UI never talks to the bridge; the bridge accepts
server-to-server calls only (shared token). Routes:

- `POST /whatsapp-web-management/sessions` (owner) → proxies bridge
  `POST /sessions`, returns QR string / pairing code for the UI.
- `GET /whatsapp-web-management/sessions/:address` → pairing/connection status.
- `DELETE /whatsapp-web-management/sessions/:address` → logout, delete device
  from session store, clean up `organizations_addresses`.

Division of labor: bridge = pure WhatsApp I/O; management = all
onboarding-related DB writes (upserts `organizations_addresses` with
`service='whatsapp-web'`, `address` = number/JID, `extra` =
`{device_jid, bridge_url}` once pairing completes — poll or bridge callback).
Fits the `onboarding_tokens.service` generalization.

### 5. Bridge (Go, stateless)

- whatsmeow `sqlstore` → `whatsmeow` schema, dedicated role owning only that
  schema. `database/sql` pool opened once at startup, small and bounded
  (`SetMaxOpenConns(5)`, `SetMaxIdleConns(2)`, `SetConnMaxLifetime(30m)`) —
  never connect-per-message. Hosted Supabase: Supavisor 6543 transaction mode
  (verify whatsmeow behaves; else 5432 session mode).
- All OpenBSP interaction over HTTPS: webhook (in), dispatcher payloads accepted
  on its own HTTP endpoint (out), management (lifecycle).
- SQLite session store **rejected**: would make the container stateful
  (persistent volume, backups) just to avoid a few pooled connections.
- Earlier iterations **rejected**: direct SQL inserts into `public.messages`
  (required `public.*` grants + replicating upsert/status-merge semantics in the
  bridge) and signed-URL media choreography (obsolete once the generic webhook
  accepts media bytes).

## Self-hosting docs sketch (README addition, once built)

```yaml
# docker-compose excerpt for self-hosters
services:
  whatsmeow-bridge:
    image: ghcr.io/<org>/open-bsp-whatsmeow
    environment:
      DATABASE_URL: postgres://whatsmeow:... # own schema only (sessions)
      OPENBSP_URL: http://kong:8000/functions/v1
      CONNECTOR_TOKEN: ... # auth for connector-webhook posts
      BRIDGE_TOKEN: ... # bearer expected from dispatcher/management
    ports: ["8081:8081"] # called by whatsapp-web-dispatcher/-management
```

Steps: run the container → create session (QR via UI/management) → number
appears as a `whatsapp-web`-service address → chat as usual. Caveats to
document: unofficial API (ban risk), phone must stay registered, no templates/no
business features, media flows through the bridge.

## Decisions (2026-07-14)

1. **Service enum value: `whatsapp-web`** (protocol, not implementation) —
   dispatcher slug therefore `whatsapp-web-dispatcher`.
2. **`external_id` prefixed** — whatsmeow IDs are only unique per chat/sender,
   but `messages.external_id` is globally unique. Scheme:
   `wmw.<own-jid>.<chat>.<id>` (exact shape TBD at implementation).
3. **`contacts_addresses` PK gains `service`** →
   `(organization_id, service,
   address)`; `conversations.contact_address` FK
   extends to include `service` (column already exists there). Address stores
   the meaningful part: bare digits, canonicalized. Cross-service "same human"
   identity stays at the `contacts` level via `contact_id`, as designed. Do this
   migration as its own PR before any bridge code.
4. **Retry**: already exists — `dispatch-outgoing-pending-messages` cron
   (`20250908132910_cron_jobs.sql`) re-fires pending outgoing messages every
   minute for 12h. Consequence: the bridge MUST be idempotent on message `id`
   (send-succeeded-but-commit-failed gets re-dispatched). Known gap
   (pre-existing): after 12h a message stays `pending` forever, never `failed`.
5. **Echoes: post everything.** The bridge forwards all `IsFromMe` events to the
   webhook; upsert on `external_id` dedupes bridge-sent messages, and phone-sent
   messages land as outgoing rows (the `smb_message_echoes` equivalent). Leave a
   comment in the bridge event loop explaining this.
6. **Self-host only** — one deployment-level bridge, URL/token in Vault. No
   per-org bridge registration on the hosted platform (avoids per-org token
   scoping, SSRF to arbitrary customer URLs, ban liability).
7. **Groups AND history sync are in scope for v0** — see notes below.
8. **One replica** until problems arise (a WhatsApp session is one WebSocket; no
   HA story needed yet).
9. **Session death**: on `LoggedOut`/ban the bridge POSTs to
   `whatsapp-web-management` (auth: `BRIDGE_TOKEN`), which updates
   `organizations_addresses` so the UI can prompt re-pairing.
10. **Bridge lives in a new repo: `open-bsp-whatsmeow`** (own CI + Docker
    publishing, like `n8n-nodes-openbsp`).

### v0 groups — notes

- Schema is mostly ready: `conversations.group_address` (+ index), `messages`
  carries both `group_address` and `contact_address`, and
  `before_insert_on_messages` looks up by all three. Group conversation =
  `(organization_address, group_address)`, per-message sender in
  `messages.contact_address` (participant) — participants need
  `contacts_addresses` rows (pushnames come with messages).
- Group metadata: `conversations.name` from `GetGroupInfo` (subject);
  participant JID-vs-LID mapping via whatsmeow's store.
- open-bsp-ui needs only minimal changes for groups (confirmed by the user) —
  the data model was built for them; this path is just unexercised.

### v0 history sync — notes

- `events.HistorySync` arrives after pairing (recent chats, as sent by the
  phone). Direction from `IsFromMe`; original timestamps preserved.
- **Backfill must not trigger automation — solved by existing convention, no new
  marker needed.** `status.pending` is the universal automation gate: live
  incoming rows get it from the column default, and every automation trigger
  (`handle_incoming_message_to_agent`, `handle_message_to_media_preprocessor`,
  dispatcher triggers) requires `status->>'pending' is not null`. History rows
  are inserted with an explicit final status instead — exactly what
  `whatsapp-webhook` does for Meta's history field (maps
  `history_context.status` via `historyStatusMap`, remapping Meta's `pending` →
  `accepted`; see the "1 and 2 do not set status.pending" comment at
  `03-05_messages.sql:131-137`). `pause_conversation_on_human_message` is
  additionally guarded by a 10-second recency window. The generic webhook's
  history mode = "insert with caller-supplied final status", nothing more.
- Media in history is often no longer downloadable (needs media-retry requests):
  v0 imports text + metadata; media messages get a `FilePart` without bytes
  (unavailable placeholder, like the oversized-media path).
- Contract implication: `/messages` must accept batches (history arrives in
  chunks of hundreds).

## Open questions

- Generic webhook naming/registration: one `connector-webhook` for all services
  vs per-service slugs wrapping a `_shared/` core (dispatcher is forced into
  per-service slugs by the trigger convention; webhook is not).
- LID/BSUID: whatsmeow has its own LID mapping (`sqlstore.CachedLIDMap`) —
  aligns with the planned canonical-key migration for Meta accounts.
- Later: generalize management for other unofficial WhatsApp integrations
  (QR-pairing shape is common) — explicitly out of scope for now.
