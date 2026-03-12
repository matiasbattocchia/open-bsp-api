create table billing.plans (
  id text not null,
  min_tier int not null,
  price numeric not null,
  billing_cycle text,
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.plans
add constraint plans_pkey
primary key (id);

alter table only billing.plans
add constraint plans_billing_cycle_check
check (billing_cycle in ('month', 'year'));

create trigger set_updated_at
before update
on billing.plans
for each row
execute function public.moddatetime('updated_at');
