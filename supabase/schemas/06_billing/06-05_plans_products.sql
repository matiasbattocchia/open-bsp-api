create table billing.plans_products (
  plan_id text not null,
  product_id text not null,
  interval text not null,
  included numeric,
  unit_price numeric,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.plans_products
add constraint plans_products_pkey
primary key (plan_id, product_id);

alter table only billing.plans_products
add constraint plans_products_plan_id_fkey
foreign key (plan_id)
references billing.plans(id)
on delete cascade;

alter table only billing.plans_products
add constraint plans_products_product_id_fkey
foreign key (product_id)
references billing.products(id)
on delete cascade;

alter table only billing.plans_products
add constraint plans_products_interval_check
check (interval in ('month', 'lifetime'));

create trigger set_updated_at
before update
on billing.plans_products
for each row
execute function public.moddatetime('updated_at');
