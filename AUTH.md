# Authentication

OpenBSP uses API keys stored in the `api_keys` table. Authentication works differently depending on whether you're calling the **REST API** (PostgREST) or an **Edge Function**.

## Headers Overview

| Header | What it carries | Who consumes it |
|---|---|---|
| `apikey` | Supabase anon key or publishable key | Kong gateway → PostgREST (sets Postgres role) |
| `Authorization` | `Bearer <token>` | PostgREST (validates as JWT) or Edge Function (passes through) |
| `api-key` | OpenBSP API key | RLS via `get_authorized_orgs()` |

## REST API

PostgREST determines the Postgres role from the `apikey` header. The `Authorization` header is **optional** — if present, PostgREST validates it as a JWT and rejects malformed tokens (PGRST301). If absent, it falls back to `apikey`.

```bash
curl '<SUPABASE_URL>/rest/v1/<table>?select=*' \
  -H "apikey: <SUPABASE_ANON_KEY_OR_PUBLISHABLE_KEY>" \
  -H "api-key: <OPENBSP_API_KEY>"
```

> **⚠️ Do NOT set** `Authorization: Bearer <openbsp_key>` — PostgREST will reject it since it's not a valid JWT.

### How RLS resolves the organization

The function `get_authorized_orgs()` in [`04-01_auth_helpers.sql`](supabase/schemas/04_functions_post_tables/04-01_auth_helpers.sql):

1. Checks `auth.uid()` — if a user JWT is present, resolves org via the `agents` table
2. Falls back to `api-key` header — looks up the key in `api_keys` and returns the org

For API-key-only requests (no `Authorization` header), `auth.uid()` is null, so it falls through to step 2.

## Edge Functions

Kong passes the `Authorization` header directly to the Deno function **without JWT validation**. The function's own middleware handles auth.

```bash
curl '<SUPABASE_URL>/functions/v1/<function-name>' \
  -X POST \
  -H "Authorization: Bearer <OPENBSP_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

No `apikey` header needed. The middleware in each function (e.g. [`mcp/index.ts`](supabase/functions/mcp/index.ts)):

1. Extracts the Bearer token from `Authorization`
2. Looks it up in `api_keys`
3. Creates a Supabase client via `createApiClient()` which internally uses `SUPABASE_ANON_KEY` for PostgREST and sets the OpenBSP token as the `api-key` custom header for RLS

## Supabase JS Client

```typescript
createClient<Database>(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY")!,  // sent as apikey + Authorization automatically
  {
    auth: { persistSession: false },
    global: {
      headers: { "api-key": token },    // OpenBSP key as custom header
    },
  },
);
```

The JS client sends the second argument as both `apikey` and `Authorization: Bearer` automatically.

## Request Flow

```
REST API                              Edge Function
────────                              ─────────────
  apikey ──► Kong ──► PostgREST         Authorization ──► Kong ──► Deno function
                        │                                            │
                    (validates JWT      (no JWT validation,          │
                     if Authorization    passes through)             │
                     is present)                                     ▼
                        │                                     middleware extracts
                        ▼                                     Bearer token, looks
                    sets Postgres role                        up in api_keys
                        │
                        ▼
                    RLS policies call
                    get_authorized_orgs()
                        │
                    reads api-key header
                    from request.headers
                        │
                    looks up in api_keys
```

## Test Results

Tested against local Supabase with anon key in `apikey` and OpenBSP key `1234567890` in `api-key`:

| `Authorization` header | HTTP | Notes |
|---|---|---|
| `Bearer <anon_jwt>` | ✅ 200 | Standard flow |
| *(omitted)* | ✅ 200 | PostgREST uses `apikey` for role |
| `Bearer fake_garbage` | ❌ 401 | PGRST301 — PostgREST rejects before SQL runs |
| `Bearer <openbsp_key>` | ❌ 401 | PGRST301 — not a JWT |

Publishable key (`sb_publishable_...`) also works as `apikey`.
