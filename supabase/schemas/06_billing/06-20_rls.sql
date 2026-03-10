-- Config tables: read-only for everyone, no user writes

alter table billing.products enable row level security;

create policy "anyone can read products"
on billing.products
for select
to authenticated, anon
using (true);

alter table billing.tiers enable row level security;

create policy "anyone can read tiers"
on billing.tiers
for select
to authenticated, anon
using (true);

alter table billing.tiers_products enable row level security;

create policy "anyone can read tiers_products"
on billing.tiers_products
for select
to authenticated, anon
using (true);

alter table billing.plans enable row level security;

create policy "anyone can read plans"
on billing.plans
for select
to authenticated, anon
using (true);

alter table billing.plans_products enable row level security;

create policy "anyone can read plans_products"
on billing.plans_products
for select
to authenticated, anon
using (true);

-- Billing state: readable by org members, writable only by triggers (security definer)

alter table billing.subscriptions enable row level security;

create policy "members can read their org subscription"
on billing.subscriptions
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

alter table billing.usage enable row level security;

create policy "members can read their org usage"
on billing.usage
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

alter table billing.ledger enable row level security;

create policy "members can read their org ledger"
on billing.ledger
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

-- Financial tables: readable by org owners only, writable only by system

alter table billing.accounts enable row level security;

create policy "owners can read their accounts"
on billing.accounts
for select
to authenticated, anon
using (
  id in (
    select s.account_id
    from billing.subscriptions s
    where s.organization_id in (
      select public.get_authorized_orgs('owner')
    )
    and s.account_id is not null
  )
);

alter table billing.invoices enable row level security;

create policy "owners can read their org invoices"
on billing.invoices
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);

alter table billing.invoices_items enable row level security;

create policy "owners can read their org invoice items"
on billing.invoices_items
for select
to authenticated, anon
using (
  invoice_id in (
    select i.id
    from billing.invoices i
    where i.organization_id in (
      select public.get_authorized_orgs('owner')
    )
  )
);

alter table billing.payments enable row level security;

create policy "owners can read their org payments"
on billing.payments
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);
