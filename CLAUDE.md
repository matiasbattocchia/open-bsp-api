# CLAUDE.md

## Project overview

Open BSP API — a multi-tenant WhatsApp Business Platform integration built with
Deno, Postgres, and Supabase Edge Functions. See README.md for full details.

## Local checks must match CI (deno)

CI (`.github/workflows/check.yml`) runs:

```bash
deno fmt --check
cd supabase/functions && deno lint && deno check .
cd plugin && deno lint && deno check .
```

**`deno check` only works from inside the package dir.** Run
`cd supabase/functions && deno check .` — NOT `deno check <file>` from the repo
root. The import map lives in `supabase/functions/deno.json` (there is no root
`deno.json`), so checking a file from the root resolves no bare specifiers and
prints **false** `Import "@supabase/supabase-js" not a dependency` /
`"ky"`/`"zod"`/`"postgres"` errors. These are an artifact of the wrong CWD, not
real errors — don't treat them as a pre-existing baseline.

> The `.claude/settings.json` PostToolUse hook runs `deno check <file>` without
> `cd` and swallows output with `|| true`, so it always "passes" for functions
> files and verifies nothing there. Run the CI command yourself to actually
> verify.

**`deno fmt` output is deno-version-dependent.** The repo pins fmt _config_
(lineWidth 80, semicolons, double quotes) but not the deno _binary_ (CI uses
`v2.x`). A different local deno can report spurious diffs on generated files
(e.g. `_shared/db_types.ts`). Only format files you actually changed; never
reformat the whole tree to chase a version-difference diff.

## Debugging production edge functions

### Timestamps

The current date/time is NOT reliably in the conversation context. When querying
logs with time ranges (e.g., "last 12 hours"), **always run `date -u` first** to
get the actual current UTC time. Do not guess or hardcode timestamps.

### Querying edge function logs

Use the Supabase Management API `logs` endpoint (or the Supabase MCP
`query_logs` tool, which runs the same queries). Every source is one `logs`
table, picked with `source`; nested fields are `log_attributes['<key>']`:

```bash
ACCESS_TOKEN=$(cat ~/.supabase/access-token)
REF="nheelwshzbgenpavwhcy"

curl -s "https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -G \
  --data-urlencode "sql=select timestamp, event_message from logs where source = 'function_logs' and positionCaseInsensitive(event_message, 'ERROR_KEYWORD') > 0 order by timestamp desc limit 10" \
  --data-urlencode "iso_timestamp_start=2026-04-10T00:00:00Z" \
  --data-urlencode "iso_timestamp_end=2026-04-10T12:00:00Z"
```

- `function_logs` is edge function stdout (`console.log` / `console.error`).
- `function_edge_logs` is one row per invocation: `log_attributes` keys
  `request.pathname`, `response.status_code`, `execution_time_ms`,
  `function_id`, `version`. No stdout.
- Other sources: `edge_logs`, `postgres_logs`, `postgrest_logs`, `auth_logs`,
  `storage_logs`, `realtime_logs` —
  `select source, count() from logs group by
  source` lists them.

ClickHouse SQL. The window is at most 24 hours; always pass both timestamps.

### Applying database fixes

1. Edit the schema file under `supabase/schemas/`
2. Generate migration: `npx supabase db diff -f <migration_name>`
3. Apply locally: `npx supabase migration up --local` (test before committing)
4. Commit — the user pushes and CI deploys automatically

### Application-level error logs

The `public.logs` table stores application-level errors written by edge
functions (e.g., webhook errors from Meta). Query with:

```sql
SELECT level, category, message, metadata, created_at
FROM public.logs
WHERE level = 'error' AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;
```

## Database migrations

- Never modify applied migrations. Always create new ones.
- Migrations are **generated** from schema diffs, not manually written: edit the
  schema files under `supabase/schemas/`, then run
  `npx supabase db diff -f <migration_name>`.
- **Never hand-create or hand-edit a migration** except for a few exceptional
  cases that `db diff` can't produce:
  - **Trim spurious `revoke` noise** — `db diff` emits ~144
    `revoke ... from
    anon|authenticated|service_role` lines every run (a
    migra/Supabase default-privilege artifact). Delete them; keep only your real
    changes.
  - **DML / data backfills** — `db diff` emits schema DDL only. Hand-write data
    updates (e.g. backfilling a new column on existing rows).
  - **Imperative bits db diff can't model** — e.g. `cron.schedule(...)` /
    pg_cron jobs (see `*_cron.sql` migrations).
  - **Enum value additions** — for an enum used by a column that an RLS policy
    (or other dependent) references, `db diff`'s rename/recreate/recast fails to
    apply: _"cannot alter type of a column used in a policy definition"_. Still
    add the value to the enum in `supabase/schemas/01_types.sql`, but replace
    the generated recast with hand-written
    `alter type public.<enum> add value if not
    exists '<v>';` (appends in
    place, touches no columns/policies). The recast is only safe when nothing
    references the column (e.g. `webhook_table`).

  Everything else (columns, policies, triggers, functions) must come from
  editing `supabase/schemas/` and re-running `db diff` — don't append DDL by
  hand.
- Migrations apply automatically via CI: pushing to `origin/develop` deploys to
  DEV, pushing to `origin/main` deploys to PROD. Never apply migrations manually
  or execute DDL directly on production.
- See README.md "Local development > Database" for the full workflow.

## Generated types

`supabase/functions/_shared/db_types.ts` is **autogenerated** — never hand-edit
it. Regenerate it from the local database after applying a migration:

```bash
npx supabase gen types typescript --local > supabase/functions/_shared/db_types.ts
```

The UI repo mirrors this file at `open-bsp-ui/src/supabase/db_types.ts` — copy
it over after regenerating. See README.md "Local development > Database".
