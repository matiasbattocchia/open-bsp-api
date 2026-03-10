create table billing.ledger (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  product_id text not null,
  type text not null,
  quantity numeric not null,
  description text,
  -- AI-specific (null for grants/topups)
  agent_id uuid,
  message_id uuid,
  provider text,
  model text,
  metadata jsonb,
  billable boolean,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only billing.ledger
add constraint ledger_pkey
primary key (id);

alter table only billing.ledger
add constraint ledger_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only billing.ledger
add constraint ledger_product_id_fkey
foreign key (product_id)
references billing.products(id);

alter table only billing.ledger
add constraint ledger_agent_id_fkey
foreign key (agent_id)
references public.agents(id)
on delete set null;

alter table only billing.ledger
add constraint ledger_message_id_fkey
foreign key (message_id)
references public.messages(id)
on delete set null;

alter table only billing.ledger
add constraint ledger_type_check
check (type in ('grant', 'consumption', 'topup'));

create index ledger_organization_id_idx
on billing.ledger
using btree (organization_id);

create index ledger_created_at_idx
on billing.ledger
using btree (created_at);

create trigger set_updated_at
before update
on billing.ledger
for each row
execute function public.moddatetime('updated_at');
