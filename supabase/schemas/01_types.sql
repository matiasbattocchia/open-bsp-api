
create type public.service as enum (
  'whatsapp',
  'instagram',
  'local',
  'slack',
  'discord',
  'teams',
  'whatsapp-web',
  'tiktok'
);

create type public.webhook_operation as enum ('insert', 'update');

create type public.webhook_table as enum (
  'messages',
  'conversations',
  'organizations_addresses',
  'contacts_addresses',
  'logs'
);

create type public.role as enum ('owner', 'admin', 'member');
