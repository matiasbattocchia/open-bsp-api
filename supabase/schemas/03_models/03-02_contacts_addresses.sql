-- FRONTEND NOTE: PostgreSQL checks INSERT policy BEFORE conflict detection.
-- Upsert with synced.action='add' in payload fails even if row exists.
-- Use .upsert() for linking, .update() for unlinking.

create table public.contacts_addresses (
  organization_id uuid not null,
  contact_id uuid,
  service public.service not null,
  address text not null,
  extra jsonb,
  status text default 'active'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.contacts_addresses
add constraint contacts_addresses_pkey
primary key (organization_id, address);

alter table only public.contacts_addresses
add constraint contacts_addresses_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.contacts_addresses
add constraint contacts_addresses_contact_id_fkey
foreign key (contact_id)
references public.contacts(id)
on delete set null;

create index contacts_addresses_contact_id_idx 
on public.contacts_addresses using btree (contact_id);

create trigger set_extra
before update
on public.contacts_addresses
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.contacts_addresses
for each row
execute function public.moddatetime('updated_at');

create trigger manage_contact_on_address_sync -- Should execute before merge_update
before insert or update
on public.contacts_addresses
for each row
when (
  new.extra->'synced' is not null -- Performance optimization
)
execute function public.manage_contact_on_address_sync();

create trigger cleanup_unlinked_address_if_empty
after update
on public.contacts_addresses
for each row
when (
  old.contact_id is not null
  and new.contact_id is null
  and new.extra->'synced'->>'action' is distinct from 'add' -- Ignore active synced addresses
)
execute function public.cleanup_unlinked_address_if_empty();
