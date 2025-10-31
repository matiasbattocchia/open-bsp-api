create table public.organizations (
  id uuid default gen_random_uuid() not null,
  name text not null,
  extra jsonb,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.organizations
add constraint organizations_pkey
primary key (id);

create trigger handle_new_organization
after insert
on public.organizations
for each row
execute function public.create_organization();

create trigger set_extra
before update
on public.organizations
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.organizations
for each row
execute function public.moddatetime('updated_at');
