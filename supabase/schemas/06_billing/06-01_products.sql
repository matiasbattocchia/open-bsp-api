create table billing.products (
  id text not null,
  name text not null,
  unit text not null,
  kind text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.products
add constraint products_pkey
primary key (id);

alter table only billing.products
add constraint products_unit_check
check (unit in ('count', 'mb', 'usd'));

alter table only billing.products
add constraint products_kind_check
check (kind in ('counter', 'gauge', 'balance'));

create trigger set_updated_at
before update
on billing.products
for each row
execute function public.moddatetime('updated_at');
