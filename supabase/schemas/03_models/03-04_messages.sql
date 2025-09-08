create table public.messages (
  id text default gen_random_uuid() not null,
  external_id text,
  service public.service not null,
  organization_address text not null,
  contact_address text not null,
  direction public.direction not null,
  type public.type not null,
  message jsonb not null,
  agent_id text,
  status jsonb default jsonb_build_object('pending', now()) not null,
  timestamp timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.messages
add constraint messages_external_id_key unique (external_id);

alter table only public.messages
add constraint messages_pkey primary key (id);

create index messages_idx
on public.messages
using btree (organization_address, timestamp);

create index messages_organization_address_created_at_idx
on public.messages
using btree (organization_address, created_at);

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