create schema if not exists billing;

grant usage on schema billing to anon, authenticated, service_role;
grant select on all tables in schema billing to anon, authenticated, service_role;
grant insert, update on all tables in schema billing to service_role;
alter default privileges in schema billing grant select on tables to anon, authenticated, service_role;
alter default privileges in schema billing grant insert, update on tables to service_role;

-- Revoke default execute on future functions; only triggers call them
alter default privileges in schema billing revoke execute on functions from public;
-- But allow service_role to call RPC functions (check_limit, etc.)
grant execute on all functions in schema billing to service_role;
