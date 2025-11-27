create table public.contacts (
  organization_id uuid not null,
  id uuid default gen_random_uuid() not null,
  name text not null,
  extra jsonb,
  status text default 'active'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.contacts
add constraint contacts_pkey
primary key (id);

alter table only public.contacts
add constraint contacts_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

create index contacts_organization_id_idx
on public.contacts
using btree (organization_id);

create trigger set_extra
before update
on public.contacts
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.contacts
for each row
execute function public.moddatetime('updated_at');
