create table billing.tiers (
  id text not null,
  name text not null,
  level int not null default 0,
  active boolean not null default true,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.tiers
add constraint tiers_pkey
primary key (id);

create trigger set_updated_at
before update
on billing.tiers
for each row
execute function public.moddatetime('updated_at');
