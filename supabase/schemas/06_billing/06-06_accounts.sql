create table billing.accounts (
  id uuid default gen_random_uuid() not null,
  name text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.accounts
add constraint accounts_pkey
primary key (id);

create trigger set_updated_at
before update
on billing.accounts
for each row
execute function public.moddatetime('updated_at');
