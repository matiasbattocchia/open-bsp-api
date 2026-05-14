# Ideas

## Managed Agents (Prototype Inheritance)

### Problem

A user builds an agent solution (e.g., for currency exchange) on the hosted platform and wants to offer it to other businesses in the same industry. Current challenges:

- **Cloning doesn't scale** - API keys/OAuth can't transfer, updates don't propagate
- **No sharing mechanism** - agents are strictly isolated per organization
- **Setup complexity** - tools requiring external integrations are hard for non-technical users

### Proposed Solution

Use prototypal inheritance: Org B creates an agent that references ("inherits from") Org A's published agent.

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
    allow_overrides?: ('instructions' | 'model' | 'temperature')[];
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

| Field | Behavior |
|-------|----------|
| `instructions` | Inherit, can override |
| `tools` | Inherit, can override or extend |
| `model`, `temperature`, etc. | Inherit, can override |
| `api_key`, `api_url` | Inherit (publisher's secrets stay with publisher) |
| `prototype` | Never inherit (no chaining) |
| `published` | Never inherit |
| `mode` | Local only (subscriber controls active/inactive) |

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

- **Discovery**: How do subscribers find published agents? Direct link vs marketplace view
- **Tool extension**: Replace subscriber's tools or merge with prototype's?
- **Versioning**: What if publisher breaks something? Pinned versions?
- **Billing**: Usage tracking for revenue share (future)
- **Unpublishing**: Graceful degradation when prototype becomes unavailable

## Data Export (Hosted → Self-Hosted)

Allow users to export their organization data from the hosted instance (web.openbsp.dev) and import it into a self-hosted deployment.

### Why it works

- All data is cleanly partitioned by `organization_id` — no cross-org FK references.
- All primary keys are UUIDs — no sequence collisions on import.
- Both instances run the same schema.

### Export script (TypeScript + Supabase client)

The user authenticates with an **owner-role API key** via the `api-key` header. Almost every table is readable through PostgREST + RLS:

| Table | API-key readable | Role needed |
|-------|------------------|-------------|
| organizations | Yes | member |
| organizations_addresses | Yes | member |
| contacts | Yes | member |
| contacts_addresses | Yes | member |
| conversations | Yes | member |
| messages | Yes | member |
| agents | Yes | member |
| api_keys | Yes | owner |
| webhooks | Yes | admin |
| quick_replies | Yes | member |
| storage.objects | Yes (Storage API for files) | member |
| onboarding_tokens | No (JWT only) | — |
| logs | No (no RLS policies) | — |

The two inaccessible tables (onboarding_tokens, logs) are not important for migration. Storage files need the Storage API to download (not PostgREST).

Output: JSON dump + downloaded media files.

### Import script (SQL)

The self-hosted owner has DB credentials. Procedure:

1. Disable triggers on all target tables (`DISABLE TRIGGER ALL`)
2. INSERT org data from the JSON dump
3. Import agents with `user_id = NULL` (users will re-link on signup via the existing `lookup_agents_by_email` trigger)
4. Re-enable triggers (`ENABLE TRIGGER ALL`)
5. Call `billing.initialize_subscription(<org_id>)` to set up fresh billing
6. Re-upload storage files via Storage API

### Key decisions

- **Skip billing data** — let the self-hosted instance initialize fresh subscriptions; importing stale usage counters would be confusing.
- **Skip auth.users** — Supabase Auth (GoTrue) manages these; can't INSERT directly. Instead, agents arrive with `user_id = NULL` and pending invitations. When users sign up on the new instance, the `lookup_agents_by_email_after_insert_on_auth_users` trigger auto-links them by email.
- **Triggers must be disabled during import** — otherwise message inserts fire `agent-client` (LLM calls), `whatsapp-dispatcher` (sends to WhatsApp), billing checks, and webhook notifications.
- **WhatsApp webhook URL must be updated** — after migration, each connected WhatsApp account's callback URL in the Meta App Dashboard still points to the hosted instance (`nheelwshzbgenpavwhcy.supabase.co`). It needs to be re-pointed to the new Supabase project's `whatsapp-webhook` endpoint. This could be automated via the WhatsApp Business Management API (`POST /{app-id}/subscriptions`) or done manually per app in Meta > WhatsApp > Configuration.

## Storage Cleanup on Organization Deletion

### Problem

`storage.objects` has no FK to `organizations` — the org ID is embedded in the file path (`organizations/<org_id>/attachments/<file_id>`), so `ON DELETE CASCADE` can't help. Supabase's `storage.delete()` SQL function only removes the metadata row, not the physical file from S3. The Storage HTTP API is the only way to delete both.

### Options

1. **Edge Function cleanup** — `AFTER DELETE` trigger on `organizations` fires `net.http_post` (pg_net) to a small Edge Function that calls `supabase.storage.from('media').list(...)` then `.remove(paths)`. Real-time but requires an HTTP hop outside the Postgres transaction.
2. **Cron job** — a scheduled function that finds org IDs in storage paths that no longer exist in `organizations` and cleans them up. Decoupled but delayed.
3. **Accept orphans** — if org deletion is rare, let files sit. Storage cost is low and orphaned files are inaccessible anyway (RLS blocks reads for non-existent orgs).
