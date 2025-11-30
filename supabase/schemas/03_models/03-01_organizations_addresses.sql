create table public.organizations_addresses (
  organization_id uuid not null,
  service public.service not null,
  address text not null,
  extra jsonb,
  status text default 'active'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.organizations_addresses
add constraint organizations_addresses_pkey
primary key (address);

alter table only public.organizations_addresses
add constraint organizations_addresses_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

create index organizations_addresses_organization_id_idx
on public.organizations_addresses
using btree (organization_id);

create trigger set_extra
before update
on public.organizations_addresses
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.organizations_addresses
for each row
execute function public.moddatetime('updated_at');

create index organizations_addresses_waba_id_idx
on public.organizations_addresses
using btree ((extra->>'waba_id'))
where service = 'whatsapp';
