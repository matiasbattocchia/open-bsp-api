# Ideas

## Managed Agents (Prototype Inheritance)

### Problem

A user builds an agent solution (e.g., for currency exchange) on the hosted
platform and wants to offer it to other businesses in the same industry. Current
challenges:

- **Cloning doesn't scale** - API keys/OAuth can't transfer, updates don't
  propagate
- **No sharing mechanism** - agents are strictly isolated per organization
- **Setup complexity** - tools requiring external integrations are hard for
  non-technical users

### Proposed Solution

Use prototypal inheritance: Org B creates an agent that references ("inherits
from") Org A's published agent.

```
┌─────────────────────────┐         ┌─────────────────────────┐
│ Org A (Publisher)       │         │ Org B (Subscriber)      │
│                         │         │                         │
│  Agent a                │         │  Agent b                │
│  ├─ instructions: "..." │◄────────│  ├─ prototype: {a.id}   │
│  ├─ tools: [...]        │ inherits│  ├─ instructions: "..." │ ← override
│  ├─ model: "gpt-5"      │         │  └─ (tools inherited)   │
│  └─ published: true     │         │                         │
└─────────────────────────┘         └─────────────────────────┘
```

### Type Extension

```typescript
export type AIAgentExtra = {
  // ... existing fields

  // Publisher side
  published?: {
    name: string;
    description: string;
    allow_overrides?: ("instructions" | "model" | "temperature")[];
  };

  // Subscriber side
  prototype?: {
    agent_id: string;
  };
};
```

### Config Resolution

At execution time, `agent-client` merges prototype config with local overrides:

```typescript
async function resolveAgentConfig(agent: Agent): Promise<ResolvedAgentExtra> {
  const extra = agent.extra as AIAgentExtra;

  if (!extra.prototype) {
    return extra;
  }

  const prototype = await fetchAgent(extra.prototype.agent_id);

  if (!prototype?.extra?.published) {
    throw new Error("Prototype agent is not published");
  }

  return {
    ...prototype.extra,
    ...omitNulls(extra),
    prototype: undefined,
    published: undefined,
  };
}
```

### Inheritance Rules

| Field                        | Behavior                                          |
| ---------------------------- | ------------------------------------------------- |
| `instructions`               | Inherit, can override                             |
| `tools`                      | Inherit, can override or extend                   |
| `model`, `temperature`, etc. | Inherit, can override                             |
| `api_key`, `api_url`         | Inherit (publisher's secrets stay with publisher) |
| `prototype`                  | Never inherit (no chaining)                       |
| `published`                  | Never inherit                                     |
| `mode`                       | Local only (subscriber controls active/inactive)  |

### Benefits

1. **No new tables** - extends existing agent model
2. **Subscriber's agent is real** - passes FK constraints, RLS, existing queries
3. **Natural overrides** - set field to override, omit to inherit
4. **Secrets stay secure** - API keys never leave publisher's config
5. **Automatic updates** - subscribers get improvements immediately

### Data Isolation

- **Conversations/messages**: belong to subscriber, publisher never sees them
- **Agent config**: owned by publisher, read at execution time
- **Tool results**: stored in subscriber's messages

### Open Questions

- **Discovery**: How do subscribers find published agents? Direct link vs
  marketplace view
- **Tool extension**: Replace subscriber's tools or merge with prototype's?
- **Versioning**: What if publisher breaks something? Pinned versions?
- **Billing**: Usage tracking for revenue share (future)
- **Unpublishing**: Graceful degradation when prototype becomes unavailable

## Data Export (Hosted → Self-Hosted)

Allow users to export their organization data from the hosted instance
(web.openbsp.dev) and import it into a self-hosted deployment.

### Why it works

- All data is cleanly partitioned by `organization_id` — no cross-org FK
  references.
- All primary keys are UUIDs — no sequence collisions on import.
- Both instances run the same schema.

### Export script (TypeScript + Supabase client)

The user authenticates with an **owner-role API key** via the `api-key` header.
Almost every table is readable through PostgREST + RLS:

| Table                   | API-key readable            | Role needed |
| ----------------------- | --------------------------- | ----------- |
| organizations           | Yes                         | member      |
| organizations_addresses | Yes                         | member      |
| contacts                | Yes                         | member      |
| contacts_addresses      | Yes                         | member      |
| conversations           | Yes                         | member      |
| messages                | Yes                         | member      |
| agents                  | Yes                         | member      |
| api_keys                | Yes                         | owner       |
| webhooks                | Yes                         | admin       |
| quick_replies           | Yes                         | member      |
| storage.objects         | Yes (Storage API for files) | member      |
| onboarding_tokens       | No (JWT only)               | —           |
| logs                    | No (no RLS policies)        | —           |

The two inaccessible tables (onboarding_tokens, logs) are not important for
migration. Storage files need the Storage API to download (not PostgREST).

Output: JSON dump + downloaded media files.

### Import script (SQL)

The self-hosted owner has DB credentials. Procedure:

1. Disable triggers on all target tables (`DISABLE TRIGGER ALL`)
2. INSERT org data from the JSON dump
3. Import agents with `user_id = NULL` (users will re-link on signup via the
   existing `lookup_agents_by_email` trigger)
4. Re-enable triggers (`ENABLE TRIGGER ALL`)
5. Call `billing.initialize_subscription(<org_id>)` to set up fresh billing
6. Re-upload storage files via Storage API

### Key decisions

- **Skip billing data** — let the self-hosted instance initialize fresh
  subscriptions; importing stale usage counters would be confusing.
- **Skip auth.users** — Supabase Auth (GoTrue) manages these; can't INSERT
  directly. Instead, agents arrive with `user_id = NULL` and pending
  invitations. When users sign up on the new instance, the
  `lookup_agents_by_email_after_insert_on_auth_users` trigger auto-links them by
  email.
- **Triggers must be disabled during import** — otherwise message inserts fire
  `agent-client` (LLM calls), `whatsapp-dispatcher` (sends to WhatsApp), billing
  checks, and webhook notifications.
- **WhatsApp webhook URL must be updated** — after migration, each connected
  WhatsApp account's callback URL in the Meta App Dashboard still points to the
  hosted instance (`nheelwshzbgenpavwhcy.supabase.co`). It needs to be
  re-pointed to the new Supabase project's `whatsapp-webhook` endpoint. This
  could be automated via the WhatsApp Business Management API
  (`POST /{app-id}/subscriptions`) or done manually per app in Meta > WhatsApp >
  Configuration.

## Storage Cleanup on Organization Deletion

### Problem

`storage.objects` has no FK to `organizations` — the org ID is embedded in the
file path (`organizations/<org_id>/attachments/<file_id>`), so
`ON DELETE CASCADE` can't help. Supabase's `storage.delete()` SQL function only
removes the metadata row, not the physical file from S3. The Storage HTTP API is
the only way to delete both.

### Options

1. **Edge Function cleanup** — `AFTER DELETE` trigger on `organizations` fires
   `net.http_post` (pg_net) to a small Edge Function that calls
   `supabase.storage.from('media').list(...)` then `.remove(paths)`. Real-time
   but requires an HTTP hop outside the Postgres transaction.
2. **Cron job** — a scheduled function that finds org IDs in storage paths that
   no longer exist in `organizations` and cleans them up. Decoupled but delayed.
3. **Accept orphans** — if org deletion is rare, let files sit. Storage cost is
   low and orphaned files are inaccessible anyway (RLS blocks reads for
   non-existent orgs).

## 100% AI Agent Users

### Problem

There's no fully agentic way for AI agents to create real platform users
(`auth.users` rows) without human intervention. Today the only ways into
`auth.users` are interactive OAuth, the email-magic-link flow, or an admin
invitation — all of which need a human to click something or paste a code.

For agent-driven workflows (synthetic test users, agent-owned scratch accounts,
multi-tenant automation creating accounts on behalf of an org) we need a path
that:

- Doesn't require a real email inbox.
- Doesn't require a human to solve a CAPTCHA.
- Produces a row that's indistinguishable from a normal user (so RLS, dashboards
  and audits don't need to special-case it).

### Proposed Solution

Two-track signup. Public users keep going through the regular `auth.signUp`
endpoint, gated by CAPTCHA. Agents go through an edge function we own
(`agent-onboard`) that wraps `supabase.auth.admin.createUser()` with the
service-role key.

```ts
// edge function: agent-onboard
//   Authorization: Bearer <agent api-key>
const apiKey = req.headers.get("Authorization")?.replace("Bearer ", "");
const { data: keyRow } = await unsecure.from("api_keys")
  .select("organization_id, role").eq("key", apiKey).maybeSingle();
if (!keyRow) return new Response("unauthorized", { status: 401 });

const admin = createClient(SUPA_URL, SERVICE_ROLE_KEY);
const { data, error } = await admin.auth.admin.createUser({
  email: `agent-${stableKey}@agents.openbsp.local`, // made-up, never delivered
  email_confirm: true, // skip verification
  password: derivedPassword(stableKey), // optional, for later sign-in
  user_metadata: { source: "agent" },
  app_metadata: { source: "agent", created_by_org: keyRow.organization_id },
});
```

The admin path has **no per-IP rate limit** (it's gated by the service-role key,
not anonymous traffic), so the agent throughput is whatever the edge function
allows. Public users still get the 60 s per-IP signup window plus CAPTCHA.

If the user already exists, fall back to
`signInWithPassword({ email, password })` with the deterministic credentials.

### Open Questions

- **Password storage vs. derivation**: derive from
  `hmac(agent_secret, stableKey)` for reproducibility without storage, or
  persist on first signup in `vault.decrypted_secrets` for rotation. Likely
  derivation; rotation isn't needed for synthetic users.
- **Cleanup**: tag `app_metadata.source = 'agent'` and schedule a weekly cron
  that deletes orphan agent users with no `agents` row and `created_at` older
  than 7 days. Caps storage drift.
- **Index for the existing email-link trigger**: the post-signup trigger
  `lookup_agents_by_email_after_insert_on_auth_users` does a case-insensitive
  scan over `agents.extra->'invitation'->>'email'`. As `agents` grows this
  becomes O(N) per insert. Add a functional index on
  `lower(extra->'invitation'->>'email')` before turning agent-signup on at
  scale.
- **Abuse without CAPTCHA**: 60 users/hr/IP is the default ceiling on the public
  endpoint; the admin path has no ceiling. Move the throttle into the edge
  function (N signups per `api_key`/org/day).

### Why not anonymous sign-in

`auth.signInWithAnonymously()` skips email entirely and is conceptually clean,
but:

- RLS gotcha: anonymous users share the `authenticated` Postgres role with
  permanent users (Supabase advisor lint `0012`). Policies relying on
  `to
  authenticated` would accept them.
- 30/hr/IP rate limit on the client SDK (admin-side is unbounded).
- They're visually flagged as `is_anonymous = true`, so support tooling has to
  special-case them.

Option A (admin createUser with a reserved `@agents.openbsp.local` domain)
produces users that look like every other user, with cleaner RLS semantics.

## Agent Email Service

### Problem

OpenBSP wants an email channel symmetric to the existing WhatsApp surface —
agents send/receive email for their org, messages land in the same `messages`
table, the conversation model just works. The hard part is inbound: edge
functions can't host an MX server (HTTP-only, request/response, hard timeouts),
so we need an SMTP→HTTP relay we control without running our own daemon.

### Proposed Solution

Use Cloudflare Email Service to terminate SMTP at the edge and forward parsed
messages to a Supabase edge function as a webhook. Symmetric architecture to
WhatsApp.

```
┌──────────────┐  SMTP   ┌──────────────────┐  HTTP   ┌──────────────────┐
│ Public MTA   │ ──────▶ │ Cloudflare Email │ ──────▶ │  email-webhook   │
│ (sender)     │  inbound│  Service Worker  │  webhook│  edge function   │
└──────────────┘         │  (catch-all)     │         │  (insert into    │
                         │  - filter dom    │         │   messages)      │
                         │  - parse MIME    │         │                  │
                         │  - POST JSON     │         └──────────────────┘
                         └──────────────────┘
```

Worker outline (~50 LOC):

```ts
import PostalMime from "postal-mime";

export default {
  async email(message, env) {
    const host = message.to.split("@")[1]?.toLowerCase() ?? "";
    if (!["openbsp.dev"].some((h) => host === h || host.endsWith(`.${h}`))) {
      message.setReject("Recipient not accepted");
      return;
    }
    const parsed = await PostalMime.parse(message.raw);
    await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.EMAIL_WEBHOOK_SECRET}`,
      },
      body: JSON.stringify({
        envelope: { from: message.from, to: message.to },
        subject: parsed.subject,
        text: parsed.text,
        html: parsed.html,
        attachments: parsed.attachments,
        headers: Object.fromEntries(message.headers),
      }),
    });
  },
};
```

DNS: add the MX records Cloudflare provides for `openbsp.dev`, set a catch-all
rule "any address → Worker."

Edge function `email-webhook` mirrors `whatsapp-webhook`: verify the bearer
secret, look up the recipient against `organizations_addresses.address`, insert
into `messages` with `service='email'`, `direction='incoming'`.

### Multi-tenant Addressing

Cloudflare Email Routing applies per-zone, not per-subdomain. Wildcard MX
(`*.openbsp.dev`) would require each subdomain to be its own zone — tedious and
limited. Standard pattern: **bake the tenant ID into the local-part** instead.

- `acme-support@openbsp.dev` rather than `support@acme.openbsp.dev`.
- Worker splits on `-` (or first `.`) to recover the tenant slug; resolves it to
  `organization_id` via `organizations_addresses` lookup before the webhook
  call.

### Practical Notes

- **Size limit**: 25 MB inbound per Cloudflare. Attachments over ~5 MB → write
  to R2 from the Worker and pass a URL to the edge function; below that, inline
  base64 in the webhook body is fine.
- **Free tier**: 200 inbound emails/day. Workers Paid is needed beyond that
  (~$5/mo + small per-email).
- **Outbound**: this path is receive-only. Sending uses the separate Email
  Service REST API or the `SEND_EMAIL` Workers binding — separate concern,
  separate provider decisions (deliverability, DKIM, bounce handling).
- **Auth**: shared secret on the webhook + IP allowlist on the edge function
  closes the loop without a heavier signed-payload scheme.
- **Spam / abuse**: the Worker is the natural place for keyword filters and
  domain-reputation checks before forwarding. Cloudflare's `spam-filtering`
  example walks through this; we'd also want a simple rate limiter per envelope
  sender.
