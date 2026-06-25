create type public.direction as enum ('incoming', 'outgoing', 'internal');

create type public.service as enum ('whatsapp', 'instagram', 'local');

create type public.webhook_operation as enum ('insert', 'update');

create type public.webhook_table as enum (
  'messages',
  'conversations',
  'organizations_addresses',
  'contacts',
  'contacts_addresses',
  'logs'
);

create type public.role as enum ('owner', 'admin', 'member');
