-- Set vault secrets for edge functions

select vault.create_secret(
  'http://api.supabase.internal:8000/functions/v1',
  'edge_functions_url',
  'Edge Functions base URL'
);

-- The service role key is the same for every local project
-- Note: the new secret auth key is not yet available in the Edge Functions environment variables
select vault.create_secret(
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
  'edge_functions_token',
  'Service role key'
);

-- ============================================================================
-- SEED DATA - Minecraft Creature-Themed Organizations & Users
-- ============================================================================
--
-- Organization Structure:
-- 1. Mountain Peaks (Org 1) - Neutral creatures - Most complete, has all test data
--    - goat@craft.com (owner) - also admin of Plains, pending admin invite from Dark Forest
--    - spider@craft.com (admin)
--    - enderman@craft.com (member)
--    - bat@craft.com (pending invitation - not registered)
--
-- 2. Plains (Org 2) - Passive creatures - For cross-org testing
--    - sheep@craft.com (owner)
--    - goat@craft.com (admin - from Org 1)
--
-- 3. Dark Forest (Org 3) - Aggressive creatures - For invitation testing
--    - zombie@craft.com (owner)
--    - goat@craft.com (pending admin invitation - from Org 1)
--
-- ============================================================================

-- Create all 3 organizations
insert into public.organizations (id, name, extra) values
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'Mountain Peaks', '{"response_delay_seconds": 0, "annotations": {"mode": "active"}}'),
  ('4b293e9e-5f4a-5b7c-9d0e-1f2a3b4c5d6e', 'Plains', '{"response_delay_seconds": 0, "annotations": {"mode": "active"}}'),
  ('5c3a4f0f-6e5b-6c8d-0e1f-2a3b4c5d6e7f', 'Dark Forest', '{"response_delay_seconds": 0, "annotations": {"mode": "active"}}')
;

-- Create all users
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change) values
  -- Org 1 users (neutral creatures)
  ('00000000-0000-0000-0000-000000000000', '185f2f83-d63a-4c9b-b4a0-7e4a885799e2', 'authenticated', 'authenticated', 'goat@craft.com', crypt('goat', gen_salt('bf')), '{"provider":"email","providers":["email"]}', '{"name": "Goat", "email": "goat@craft.com"}', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now()), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '7c8a9b2d-4e3f-5a6b-8c9d-0e1f2a3b4c5d', 'authenticated', 'authenticated', 'spider@craft.com', crypt('spider', gen_salt('bf')), '{"provider":"email","providers":["email"]}', '{"name": "Spider", "email": "spider@craft.com"}', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now()), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '9d0e1f2a-3b4c-5d6e-7f8a-9b0c1d2e3f4a', 'authenticated', 'authenticated', 'enderman@craft.com', crypt('enderman', gen_salt('bf')), '{"provider":"email","providers":["email"]}', '{"name": "Enderman", "email": "enderman@craft.com"}', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now()), '', '', '', ''),
  -- Org 2 owner (passive creature)
  ('00000000-0000-0000-0000-000000000000', '296f4de0-7f6c-7d9e-1f2a-3b4c5d6e7f8a', 'authenticated', 'authenticated', 'sheep@craft.com', crypt('sheep', gen_salt('bf')), '{"provider":"email","providers":["email"]}', '{"name": "Sheep", "email": "sheep@craft.com"}', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now()), '', '', '', ''),
  -- Org 3 owner (aggressive creature)
  ('00000000-0000-0000-0000-000000000000', '3a7f5ef1-8e7d-8e0f-2a3b-4c5d6e7f8a9b', 'authenticated', 'authenticated', 'zombie@craft.com', crypt('zombie', gen_salt('bf')), '{"provider":"email","providers":["email"]}', '{"name": "Zombie", "email": "zombie@craft.com"}', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now()), '', '', '', '')
;

-- Create auth identities for all users
insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at) values
  ('185f2f83-d63a-4c9b-b4a0-7e4a885799e2', '185f2f83-d63a-4c9b-b4a0-7e4a885799e2', '185f2f83-d63a-4c9b-b4a0-7e4a885799e2', '{"sub": "185f2f83-d63a-4c9b-b4a0-7e4a885799e2", "email":"goat@craft.com"}', 'email', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now())),
  ('7c8a9b2d-4e3f-5a6b-8c9d-0e1f2a3b4c5d', '7c8a9b2d-4e3f-5a6b-8c9d-0e1f2a3b4c5d', '7c8a9b2d-4e3f-5a6b-8c9d-0e1f2a3b4c5d', '{"sub": "7c8a9b2d-4e3f-5a6b-8c9d-0e1f2a3b4c5d", "email":"spider@craft.com"}', 'email', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now())),
  ('9d0e1f2a-3b4c-5d6e-7f8a-9b0c1d2e3f4a', '9d0e1f2a-3b4c-5d6e-7f8a-9b0c1d2e3f4a', '9d0e1f2a-3b4c-5d6e-7f8a-9b0c1d2e3f4a', '{"sub": "9d0e1f2a-3b4c-5d6e-7f8a-9b0c1d2e3f4a", "email":"enderman@craft.com"}', 'email', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now())),
  ('296f4de0-7f6c-7d9e-1f2a-3b4c5d6e7f8a', '296f4de0-7f6c-7d9e-1f2a-3b4c5d6e7f8a', '296f4de0-7f6c-7d9e-1f2a-3b4c5d6e7f8a', '{"sub": "296f4de0-7f6c-7d9e-1f2a-3b4c5d6e7f8a", "email":"sheep@craft.com"}', 'email', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now())),
  ('3a7f5ef1-8e7d-8e0f-2a3b-4c5d6e7f8a9b', '3a7f5ef1-8e7d-8e0f-2a3b-4c5d6e7f8a9b', '3a7f5ef1-8e7d-8e0f-2a3b-4c5d6e7f8a9b', '{"sub": "3a7f5ef1-8e7d-8e0f-2a3b-4c5d6e7f8a9b", "email":"zombie@craft.com"}', 'email', timezone('utc'::text, now()), timezone('utc'::text, now()), timezone('utc'::text, now()))
;

-- Create agents (org memberships and invitations)
insert into public.agents (name, user_id, organization_id, ai, extra) values
  -- Mountain Peaks (Org 1) - Neutral creatures - Complete setup
  ('Goat', '185f2f83-d63a-4c9b-b4a0-7e4a885799e2', '3a182d8d-d6d8-44bd-b021-029915476b8c', false, '{"role": "owner"}'),
  ('Spider', '7c8a9b2d-4e3f-5a6b-8c9d-0e1f2a3b4c5d', '3a182d8d-d6d8-44bd-b021-029915476b8c', false, '{"role": "admin"}'),
  ('Enderman', '9d0e1f2a-3b4c-5d6e-7f8a-9b0c1d2e3f4a', '3a182d8d-d6d8-44bd-b021-029915476b8c', false, '{"role": "member"}'),
  ('Bat', null, '3a182d8d-d6d8-44bd-b021-029915476b8c', false, '{"role": "member", "invitation": {"organization_name": "Mountain Peaks", "email": "bat@craft.com", "status": "pending"}}'),
  
  -- Plains (Org 2) - Passive creatures - Owner + Goat as admin
  ('Sheep', '296f4de0-7f6c-7d9e-1f2a-3b4c5d6e7f8a', '4b293e9e-5f4a-5b7c-9d0e-1f2a3b4c5d6e', false, '{"role": "owner"}'),
  ('Goat', '185f2f83-d63a-4c9b-b4a0-7e4a885799e2', '4b293e9e-5f4a-5b7c-9d0e-1f2a3b4c5d6e', false, '{"role": "admin"}'),
  
  -- Dark Forest (Org 3) - Aggressive creatures - Owner + pending admin invitation for Goat
  ('Zombie', '3a7f5ef1-8e7d-8e0f-2a3b-4c5d6e7f8a9b', '5c3a4f0f-6e5b-6c8d-0e1f-2a3b4c5d6e7f', false, '{"role": "owner"}'),
  ('Goat', '185f2f83-d63a-4c9b-b4a0-7e4a885799e2', '5c3a4f0f-6e5b-6c8d-0e1f-2a3b4c5d6e7f', false, '{"role": "admin", "invitation": {"organization_name": "Dark Forest", "email": "goat@craft.com", "status": "pending"}}')
;

-- API Keys (for Mountain Peaks)
insert into public.api_keys (organization_id, key, role, name) values
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', '1234567890', 'member', 'Default')
;

-- AI Agents (for Mountain Peaks)
insert into public.agents (id, name, user_id, organization_id, ai, extra) values
  ('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 'Creeper', null, '3a182d8d-d6d8-44bd-b021-029915476b8c', true, 
   '{"api_url": "groq", "protocol": "chat_completions", "instructions": "You are a Creeper. You hiss and threaten to explode if anyone gets too close.", "mode": "inactive"}'),
  ('b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e', 'Cartographer', null, '3a182d8d-d6d8-44bd-b021-029915476b8c', true,
   '{"api_url": "groq", "protocol": "chat_completions", "instructions": "You are a Cartographer villager. You trade emeralds for maps.", "mode": "active", "tools": [{"name": "calculator", "type": "function", "provider": "local"}, {"type": "http", "label": "Fetch", "config": {}, "provider": "local"}]}')
;

-- Organization Addresses - WhatsApp Integration (for Mountain Peaks)
insert into public.organizations_addresses (organization_id, service, address, extra, status) values
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'whatsapp', '318232498042593', 
   '{"waba_id": "309222208943804", "phone_number": "+54 9 260 423 7115", "access_token": "EAAEKlp6x6a...GZC", "flow_type": "existing_phone_number"}', 'connected'),
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'whatsapp', '9876543210',
   '{"waba_id": "309222208943804", "phone_number": "+54 9 260 423 7116", "access_token": "EAAEKlp6x6a...GZC", "flow_type": "new_phone_number"}', 'disconnected')
;

-- Contacts (for Mountain Peaks)
-- Note: contacts.extra.addresses is a string array of contact addresses
insert into public.contacts (id, organization_id, name, extra) values
  ('c3d4e5f6-a7b8-9c0d-1e2f-3a4b5c6d7e8f', '3a182d8d-d6d8-44bd-b021-029915476b8c', 'Dolphin', 
   '{"addresses": ["541133525394"]}'),
  ('d4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a', '3a182d8d-d6d8-44bd-b021-029915476b8c', 'Wolf',
   '{"addresses": ["541133525395"]}')
;

-- Contacts Addresses (for Mountain Peaks) - required for conversations FK
insert into public.contacts_addresses (organization_id, service, address, extra) values
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'whatsapp', '541133525394', '{"name": "Dolphin"}'),
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'whatsapp', '541133525395', '{"name": "Wolf"}')
;

-- Conversations & Messages (for Mountain Peaks)
insert into public.conversations (id, organization_id, organization_address, contact_address, service, status, name, extra) values
  ('e5f6a7b8-c9d0-1e2f-3a4b-5c6d7e8f9a0b', '3a182d8d-d6d8-44bd-b021-029915476b8c', '318232498042593', '541133525394', 'whatsapp', 'active', 'Map trade', '{"default_agent_id": "b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e"}'),
  ('f6a7b8c9-d0e1-2f3a-4b5c-6d7e8f9a0b1c', '3a182d8d-d6d8-44bd-b021-029915476b8c', '318232498042593', '541133525395', 'whatsapp', 'closed', 'Emerald exchange', '{"paused": "2024-01-01T10:00:00Z", "default_agent_id": "b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e"}')
;

insert into public.messages (id, conversation_id, organization_id, organization_address, contact_address, service, direction, agent_id, content, status, timestamp) values
  ('a7b8c9d0-e1f2-3a4b-5c6d-7e8f9a0b1c2d', 'e5f6a7b8-c9d0-1e2f-3a4b-5c6d7e8f9a0b', '3a182d8d-d6d8-44bd-b021-029915476b8c', '318232498042593', '541133525394', 'whatsapp', 'incoming', null,
   '{"kind": "text", "text": "Do you have any ocean explorer maps?", "type": "text", "version": "1"}', '{"delivered": "2024-01-01T09:00:00Z"}', now() - interval '10 minutes'),
  ('b8c9d0e1-f2a3-4b5c-6d7e-8f9a0b1c2d3e', 'e5f6a7b8-c9d0-1e2f-3a4b-5c6d7e8f9a0b', '3a182d8d-d6d8-44bd-b021-029915476b8c', '318232498042593', '541133525394', 'whatsapp', 'outgoing', 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e',
   '{"kind": "text", "text": "Yes, for 13 emeralds and a compass.", "type": "text", "version": "1"}', '{"sent": "2024-01-01T09:01:00Z", "delivered": "2024-01-01T09:01:05Z"}', now() - interval '5 minutes'),
  ('c9d0e1f2-a3b4-5c6d-7e8f-9a0b1c2d3e4f', 'f6a7b8c9-d0e1-2f3a-4b5c-6d7e8f9a0b1c', '3a182d8d-d6d8-44bd-b021-029915476b8c', '318232498042593', '541133525395', 'whatsapp', 'incoming', null,
   '{"kind": "text", "text": "I have 32 rotten flesh to trade.", "type": "text", "version": "1"}', '{"delivered": "2024-01-01T14:00:00Z"}', now() - interval '1 minute')
;

-- Quick Replies (for Mountain Peaks)
insert into public.quick_replies (organization_id, name, content) values
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'Greeting', 'Welcome to Mountain Peaks! How can I help you?'),
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'Hours', 'We are open 24/7 in the Overworld!'),
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'Goodbye', 'Safe travels! Watch out for powder snow!')
;

-- Webhooks (for Mountain Peaks)
insert into public.webhooks (organization_id, table_name, operations, url, token) values
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'messages', 
   ARRAY['insert', 'update']::webhook_operation[], 
   'http://127.0.0.1:54321/rest/v1/messages', 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz'),
  ('3a182d8d-d6d8-44bd-b021-029915476b8c', 'conversations',
   ARRAY['insert']::webhook_operation[],
   'http://127.0.0.1:54321/rest/v1/conversations', 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz')
;
