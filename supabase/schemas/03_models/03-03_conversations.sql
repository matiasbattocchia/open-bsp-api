create table public.conversations (
  organization_id uuid not null,
  id uuid default gen_random_uuid() not null,
  service public.service not null,
  organization_address text,
  contact_address text, -- there is no foreign key to contacts_addresses on purpose
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
add constraint conversations_pkey
primary key (id);

alter table only public.conversations
add constraint conversations_organization_address_fkey
foreign key (organization_address)
references public.organizations_addresses(address)
on delete set null;

create index conversations_organization_id_created_at_idx
on public.conversations
using btree (organization_id, created_at);

-- We might add service (1) and created_at (4), yet it does not feel critical.
create index conversations_organization_address_contact_address_idx
on public.conversations
using btree (organization_address, contact_address);

create trigger handle_new_conversation
before insert
on public.conversations
for each row
execute function public.before_insert_on_conversations();

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
