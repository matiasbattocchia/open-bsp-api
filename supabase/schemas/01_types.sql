create type public.direction as enum ('incoming', 'outgoing', 'internal');

create type public.service as enum ('whatsapp', 'instagram', 'local');

-- todo: deprecate
create type public.type as enum (
  'incoming',
  'outgoing',
  'draft',
  'notification',
  'function_call',
  'function_response',
  'internal'
);

create type public.webhook_operation as enum ('insert', 'update');

create type public.webhook_table as enum ('messages', 'conversations');
