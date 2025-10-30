-- Set vault secrets for edge functions

select vault.create_secret(
  'http://api.supabase.internal:8000/functions/v1',
  'edge_functions_url',
  'Edge Functions base URL'
);

-- The service role key is the same for every local project
select vault.create_secret(
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
  'edge_functions_token',
  'Service role key'
);

-- Creates a default organization and user
-- user: admin
-- pass: admin

insert into public.organizations (id, name, extra) values
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'Default', '{"response_delay_seconds": 0, "annotations": {"mode": "active"}}')
;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change) values
  ('00000000-0000-0000-0000-000000000000', '185f2f83-d63a-4c9b-b4a0-7e4a885799e2', 'authenticated', 'authenticated', 'admin', crypt('admin', gen_salt('bf')), '{"provider":"email","providers":["email"]}', '{"name": "Admin", "email": "admin@example.com"}', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now()), '', '', '', '')
;

insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at) values
  ('185f2f83-d63a-4c9b-b4a0-7e4a885799e2', '185f2f83-d63a-4c9b-b4a0-7e4a885799e2', '185f2f83-d63a-4c9b-b4a0-7e4a885799e2',	'{"sub": "185f2f83-d63a-4c9b-b4a0-7e4a885799e2", "email":"admin@example.com"}', 'email', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now()))
;

insert into public.agents (name, user_id, organization_id, ai, extra) values
  ('Admin', '185f2f83-d63a-4c9b-b4a0-7e4a885799e2', '3a182d8d-d6d8-44bd-b021-029915476b8c', false, '{"roles":["admin"]}')
;

insert into public.api_keys (organization_id, key) values
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', '1234567890')
;
