create table billing.usage (
  organization_id uuid not null,
  product_id text not null,
  interval text not null default 'lifetime',
  period date not null default '1970-01-01',
  quantity numeric not null default 0,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.usage
add constraint usage_pkey
primary key (organization_id, product_id, interval, period);

alter table only billing.usage
add constraint usage_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only billing.usage
add constraint usage_product_id_fkey
foreign key (product_id)
references billing.products(id)
on delete cascade;

alter table only billing.usage
add constraint usage_interval_check
check (interval in ('day', 'month', 'lifetime'));

create trigger set_updated_at
before update
on billing.usage
for each row
execute function public.moddatetime('updated_at');
