# CLAUDE.md

## Project overview

Open BSP API — a multi-tenant WhatsApp Business Platform integration built with Deno, Postgres, and Supabase Edge Functions. See README.md for full details.

## Debugging production edge functions

### Querying stdout logs (console.log / console.error)

Use the Supabase Management API to query `function_logs` (edge function stdout):

```bash
ACCESS_TOKEN=$(cat ~/.supabase/access-token)
REF="nheelwshzbgenpavwhcy"

curl -s "https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs.all" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -G \
  --data-urlencode "sql=select cast(timestamp as datetime) as ts, event_message from function_logs where regexp_contains(event_message, 'ERROR_KEYWORD') order by timestamp desc limit 10" \
  --data-urlencode "iso_timestamp_start=2026-04-10T00:00:00Z"
```

Available log tables: `function_logs` (stdout), `function_edge_logs` (HTTP-level), `edge_logs`, `postgres_logs`, `auth_logs`, `storage_logs`, `realtime_logs`. Uses BigQuery SQL syntax. Max 1000 rows per query. Always filter by timestamp.

### Querying HTTP-level logs (status codes, execution time)

Use the Supabase MCP server `get_logs` tool with `service: "edge-function"`. This returns invocation metadata (status code, execution time, function version) but **not** stdout content.

### Applying database fixes

1. Edit the schema file under `supabase/schemas/`
2. Generate migration: `npx supabase db diff -f <migration_name>`
3. Apply locally: `npx supabase migration up --local`
4. For urgent production fixes, apply directly via the Supabase MCP `execute_sql` tool, then follow up with the migration file for consistency

### Application-level error logs

The `public.logs` table stores application-level errors written by edge functions (e.g., webhook errors from Meta). Query with:

```sql
SELECT level, category, message, metadata, created_at
FROM public.logs
WHERE level = 'error' AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;
```

## Database migrations

- Never modify applied migrations. Always create new ones.
- Migrations are **generated** from schema diffs, not manually written: edit the schema files under `supabase/schemas/`, then run `npx supabase db diff -f <migration_name>`.
- Migrations apply automatically via CI: pushing to `origin/develop` deploys to DEV, pushing to `origin/main` deploys to PROD. Never apply migrations manually or execute DDL directly on production.
- See README.md "Local development > Database" for the full workflow.
