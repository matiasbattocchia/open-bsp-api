-- 1. pg_net extension (used by triggers and cron jobs to call Edge Functions via HTTP).
--    Create the extension first: its install script provisions the `net` schema. The
--    `create schema if not exists` below is a no-op fallback for environments where the
--    extension already exists but the schema was somehow dropped.
create extension if not exists pg_net schema extensions;
create schema if not exists net;

-- 2. supabase_functions.hooks (used by edge-function triggers to log HTTP request ids).
--    No longer auto-created unless legacy Database Webhooks were enabled.
create schema if not exists supabase_functions;
create table if not exists supabase_functions.hooks (
  id bigserial primary key,
  hook_table_id oid not null,
  hook_name text not null,
  request_id bigint,
  created_at timestamptz default now()
);

-- 3. Vault permissions (SECURITY DEFINER trigger functions, owned by postgres, read
--    secrets from the vault).
grant usage on schema vault to postgres;
grant select on vault.decrypted_secrets to postgres;
