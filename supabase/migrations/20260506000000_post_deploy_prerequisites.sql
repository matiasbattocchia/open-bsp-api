-- ============================================================================
-- Post-deploy prerequisites
--
-- These objects are required for the DB triggers to call Edge Functions.
-- On some Supabase plans they exist by default; on others they must be
-- created manually. This migration is idempotent — safe to run always.
-- ============================================================================

-- 1. pg_net extension (used by triggers to call Edge Functions via HTTP)
create extension if not exists pg_net schema extensions;
create schema if not exists net;

-- 2. supabase_functions.hooks (used by triggers to log HTTP requests)
create schema if not exists supabase_functions;
create table if not exists supabase_functions.hooks (
  id bigserial primary key,
  hook_table_id oid not null,
  hook_name text not null,
  request_id bigint,
  created_at timestamptz default now()
);

-- 3. Vault permissions (triggers read secrets from vault)
grant usage on schema vault to postgres;
grant select on vault.decrypted_secrets to postgres;
