create table billing.invoices_items (
  id uuid default gen_random_uuid() not null,
  invoice_id uuid not null,
  type text not null,
  plan_id text,
  product_id text,
  ledger_id uuid,
  quantity numeric not null,
  unit_price numeric not null,
  amount numeric not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.invoices_items
add constraint invoices_items_pkey
primary key (id);

alter table only billing.invoices_items
add constraint invoices_items_invoice_id_fkey
foreign key (invoice_id)
references billing.invoices(id)
on delete cascade;

alter table only billing.invoices_items
add constraint invoices_items_plan_id_fkey
foreign key (plan_id)
references billing.plans(id);

alter table only billing.invoices_items
add constraint invoices_items_ledger_id_fkey
foreign key (ledger_id)
references billing.ledger(id);

alter table only billing.invoices_items
add constraint invoices_items_product_id_fkey
foreign key (product_id)
references billing.products(id);

alter table only billing.invoices_items
add constraint invoices_items_type_check
check (type in ('plan', 'credit', 'overage'));

create index invoices_items_invoice_id_idx
on billing.invoices_items
using btree (invoice_id);

create trigger set_updated_at
before update
on billing.invoices_items
for each row
execute function public.moddatetime('updated_at');
