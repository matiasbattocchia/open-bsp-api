create table public.conversations (
  organization_id uuid not null,
  contact_id uuid,
  id uuid default gen_random_uuid() not null,
  service public.service not null,
  organization_address text not null,
  contact_address text not null,
  name text,
  extra jsonb,
  status text default 'active'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.conversations
add constraint conversations_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.conversations
add constraint conversations_contact_id_fkey
foreign key (contact_id)
references public.contacts(id)
on delete cascade;

alter table only public.conversations
add constraint conversations_pkey
primary key (id);

alter table only public.conversations
add constraint conversations_organization_address_fkey
foreign key (organization_address)
references public.organizations_addresses(address);

create index conversations_organization_id_created_at_idx
on public.conversations
using btree (organization_id, created_at);

-- There should be a contacts_addresses table. The truth is contacts are not
-- used that much (useful for CRM features), plus even though the system supports
-- omni-channel, only whatsapp is implemented.
create index conversations_contact_id_idx
on public.conversations
using btree (contact_id);

-- We might add service (1) and created_at (4), yet it does not feel critical.
create index conversations_organization_address_contact_address_idx
on public.conversations
using btree (organization_address, contact_address);

create trigger handle_new_conversation
before insert
on public.conversations
for each row
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
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.conversations
for each row
execute function public.moddatetime('updated_at');
