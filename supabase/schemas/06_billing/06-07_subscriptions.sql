create table billing.subscriptions (
  organization_id uuid not null,
  plan_id text not null,
  account_id uuid,
  current_period_start timestamp with time zone,
  current_period_end timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.subscriptions
add constraint subscriptions_pkey
primary key (organization_id);

alter table only billing.subscriptions
add constraint subscriptions_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only billing.subscriptions
add constraint subscriptions_plan_id_fkey
foreign key (plan_id)
references billing.plans(id);

alter table only billing.subscriptions
add constraint subscriptions_account_id_fkey
foreign key (account_id)
references billing.accounts(id);

create trigger set_updated_at
before update
on billing.subscriptions
for each row
execute function public.moddatetime('updated_at');
