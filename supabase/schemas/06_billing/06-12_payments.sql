create table billing.payments (
  id uuid default gen_random_uuid() not null,
  invoice_id uuid not null,
  organization_id uuid not null,
  account_id uuid,
  amount numeric not null,
  method text,
  status text not null default 'pending',
  external_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.payments
add constraint payments_pkey
primary key (id);

alter table only billing.payments
add constraint payments_invoice_id_fkey
foreign key (invoice_id)
references billing.invoices(id)
on delete cascade;

alter table only billing.payments
add constraint payments_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only billing.payments
add constraint payments_account_id_fkey
foreign key (account_id)
references billing.accounts(id);

alter table only billing.payments
add constraint payments_status_check
check (status in ('pending', 'succeeded', 'failed', 'refunded'));

create index payments_invoice_id_idx
on billing.payments
using btree (invoice_id);

create index payments_organization_id_idx
on billing.payments
using btree (organization_id);

create trigger set_updated_at
before update
on billing.payments
for each row
execute function public.moddatetime('updated_at');
