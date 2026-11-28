create table public.organizations (
  id uuid default gen_random_uuid() not null,
  name text not null,
  -- The organization's own domain (acme.com): a bare lowercase hostname, no
  -- scheme or path. Not unique: a company's several organizations share it.
  domain text,
  extra jsonb,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.organizations
add constraint organizations_pkey
primary key (id);

alter table only public.organizations
add constraint organizations_domain_check
check (
  domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
);

create trigger handle_new_organization
after insert
on public.organizations
for each row
execute function public.after_insert_on_organizations();

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
