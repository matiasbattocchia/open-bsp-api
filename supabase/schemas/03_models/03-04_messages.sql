-- organization_id is useful for realtime. It could be argued that if there
-- is organization_id then there is room for contact_id, but it is not necessary now.
create table public.messages (
  organization_id uuid not null,
  conversation_id uuid not null,
  id uuid default gen_random_uuid() not null,
  external_id text,
  service public.service not null,
  organization_address text not null,
  contact_address text not null,
  direction public.direction not null,
  type public.type not null,
  message jsonb not null, -- TODO: rename to content during v0 -> v1 migration
  agent_id text,
  status jsonb default jsonb_build_object('pending', now()) not null,
  timestamp timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.messages
add constraint messages_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.messages
add constraint messages_conversation_id_fkey
foreign key (conversation_id)
references public.conversations(id)
on delete cascade;

alter table only public.messages
add constraint messages_pkey primary key (id);

alter table only public.messages
add constraint messages_external_id_key unique (external_id);

create index messages_organization_id_idx
on public.messages
using btree (organization_id);

create index messages_conversation_id_timestamp_idx
on public.messages
using btree (conversation_id, timestamp);

create index messages_conversation_id_created_at_idx
on public.messages
using btree (conversation_id, created_at);

create trigger handle_new_message
before insert
on public.messages
for each row
execute function public.create_message();

create trigger handle_incoming_message_to_agent
after insert
on public.messages
for each row
when (
  new.direction = 'incoming'::public.direction
  and (new.status ->> 'pending'::text) is not null
)
execute function public.edge_function('/agent-client', 'post');

create trigger handle_mark_as_read_to_dispatcher
after update
on public.messages
for each row
when (
  new.direction = 'incoming'::public.direction
  and new.service <> 'local'::public.service
  and (
    (old.status ->> 'read'::text) <> (new.status ->> 'read'::text)
    or (old.status ->> 'typing'::text) <> (new.status ->> 'typing'::text)
  )
)
execute function public.dispatcher_edge_function();

create trigger handle_outgoing_message_to_dispatcher
after insert
on public.messages
for each row
when (
  new.direction = 'outgoing'::public.direction
  and new.timestamp <= now()
  and (new.status ->> 'pending'::text) is not null
)
execute function public.dispatcher_edge_function();

create trigger handle_message_to_annotator
after insert
on public.messages
for each row
when (
  (
    new.direction = 'outgoing'::public.direction
    or new.direction = 'incoming'::public.direction
  )
  and (new.status ->> 'pending'::text) is not null
  and (
    (new.message ->> 'media') is not null -- message v0 - TODO: deprecate
    or (new.message ->> 'type') = 'file' -- message v1
  )
)
execute function public.edge_function('/annotator', 'post');

create trigger notify_webhook_messages
after insert or update
on public.messages
for each row
execute function public.notify_webhook();

create trigger set_message
before update
on public.messages
for each row
when (
  new.message is not null
)
execute function public.merge_update_message();

create trigger set_status
before update
on public.messages
for each row
when (
  new.status is not null
)
execute function public.merge_update_status();

create trigger set_updated_at
before update
on public.messages
for each row
execute function public.moddatetime('updated_at');
