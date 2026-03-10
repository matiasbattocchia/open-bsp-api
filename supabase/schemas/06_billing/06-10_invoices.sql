create table billing.invoices (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  period_start timestamp with time zone,
  period_end timestamp with time zone,
  status text not null default 'draft',
  subtotal numeric not null default 0,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.invoices
add constraint invoices_pkey
primary key (id);

alter table only billing.invoices
add constraint invoices_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only billing.invoices
add constraint invoices_status_check
check (status in ('draft', 'issued', 'paid', 'void'));

create index invoices_organization_id_idx
on billing.invoices
using btree (organization_id);

create trigger set_updated_at
before update
on billing.invoices
for each row
execute function public.moddatetime('updated_at');
