create table billing.tiers_products (
  tier_id text not null,
  product_id text not null,
  interval text not null,
  cap numeric,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.tiers_products
add constraint tiers_products_pkey
primary key (tier_id, product_id);

alter table only billing.tiers_products
add constraint tiers_products_tier_id_fkey
foreign key (tier_id)
references billing.tiers(id)
on delete cascade;

alter table only billing.tiers_products
add constraint tiers_products_product_id_fkey
foreign key (product_id)
references billing.products(id)
on delete cascade;

alter table only billing.tiers_products
add constraint tiers_products_interval_check
check (interval in ('month', 'lifetime'));

create trigger set_updated_at
before update
on billing.tiers_products
for each row
execute function public.moddatetime('updated_at');
