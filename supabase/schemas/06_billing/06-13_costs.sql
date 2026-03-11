create table billing.costs (
  provider text not null,
  product text not null,
  effective_at timestamp with time zone default now() not null,
  quantity numeric not null,
  unit text not null,
  pricing jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.costs
add constraint costs_pkey
primary key (provider, product, effective_at);

create trigger set_updated_at
before update
on billing.costs
for each row
execute function public.moddatetime('updated_at');
