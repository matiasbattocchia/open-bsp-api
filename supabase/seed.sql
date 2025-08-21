-- Creates a default organization and user
-- user: admin
-- pass: admin

insert into public.organizations (id, name, extra) values
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'Default', '{"response_delay_seconds": 0}')
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