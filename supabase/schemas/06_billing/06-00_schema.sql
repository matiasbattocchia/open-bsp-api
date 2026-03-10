create schema if not exists billing;

grant usage on schema billing to anon, authenticated;
grant select on all tables in schema billing to anon, authenticated;
alter default privileges in schema billing grant select on tables to anon, authenticated;
