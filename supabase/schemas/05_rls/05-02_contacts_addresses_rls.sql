alter table public.contacts_addresses enable row level security;

create policy "members can read their orgs contacts addresses"
on public.contacts_addresses
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

-- Members can insert addresses (BUT NOT synced "add" ones)
create policy "members can insert contacts addresses"
on public.contacts_addresses
for insert
to authenticated, anon
with check (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  and (extra->'synced'->>'action') is distinct from 'add'
);

-- Members can update contacts addresses
-- The only thing members should update is 'contact_id'.
create policy "members can update contacts addresses"
on public.contacts_addresses
for update
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
)
with check (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  and public.contact_address_update_rules(
    organization_id,
    service,
    address,
    extra,
    status
  )
);

-- Members can delete non-synced addresses
create policy "members can delete non-synced contacts addresses"
on public.contacts_addresses
for delete
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
  and (extra->'synced'->>'action') is distinct from 'add'
);