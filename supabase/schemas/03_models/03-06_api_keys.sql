create table public.api_keys (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  name text not null,
  key text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.api_keys
add constraint api_keys_key_key
unique (key);

alter table only public.api_keys
add constraint api_keys_pkey
primary key (id);

alter table only public.api_keys
add constraint api_keys_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

create index api_keys_organization_idx
on public.api_keys
using btree (organization_id);

create trigger set_updated_at
before update
on public.api_keys
for each row
execute function public.moddatetime('updated_at'); 