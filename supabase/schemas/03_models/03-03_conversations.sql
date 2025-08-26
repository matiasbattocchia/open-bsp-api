create table public.conversations (
  organization_id uuid not null,
  contact_id uuid,
  service public.service not null,
  organization_address text not null,
  contact_address text not null,
  name text not null,
  extra jsonb,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.conversations
add constraint conversations_pkey
primary key (organization_address, contact_address);

alter table only public.conversations
add constraint conversations_contact_id_fkey
foreign key (contact_id)
references public.contacts(id)
on delete cascade;

alter table only public.conversations
add constraint conversations_organization_address_fkey
foreign key (organization_address)
references public.organizations_addresses(address);

alter table only public.conversations
add constraint conversations_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

create index conversations_contact_id_idx
on public.conversations
using btree (contact_id);

create index conversations_idx
on public.conversations
using btree (organization_id, created_at);

create trigger handle_new_conversation
before insert
on public.conversations
for each row
when (
  new.organization_id is null
)
execute function public.create_conversation();

create trigger notify_webhook_conversations
after insert or update
on public.conversations
for each row
execute function public.notify_webhook();

create trigger set_extra
before update
on public.conversations
for each row
when (
  new.extra is not null
)
execute function public.merge_update_extra();

create trigger set_updated_at
before update
on public.conversations
for each row
execute function public.moddatetime('updated_at');
