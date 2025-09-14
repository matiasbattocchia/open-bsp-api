alter table public.messages enable row level security;

create policy "org members can read their orgs messages"
on public.messages
for select
to authenticated
using (
  organization_address in (
    select organizations_addresses.address
    from public.organizations_addresses
    where organizations_addresses.organization_id in (
      select public.get_authorized_orgs()
    )
  )
);

create policy "org members can create their orgs messages"
on public.messages
for insert
to authenticated
with check (
  organization_address in (
    select organizations_addresses.address
    from public.organizations_addresses
    where organizations_addresses.organization_id in (
      select public.get_authorized_orgs()
    )
  )
);

create policy "anonymous can read messages with valid api key"
on public.messages
for select
to anon
using (
  organization_address in (
    select organizations_addresses.address
    from public.organizations_addresses
    where organizations_addresses.organization_id = (
      select public.get_authorized_org_by_api_key()
    )
  )
);

create policy "anonymous can create messages with valid api key"
on public.messages
for insert
to anon
with check (
  organization_address in (
    select organizations_addresses.address
    from public.organizations_addresses
    where organizations_addresses.organization_id = (
      select public.get_authorized_org_by_api_key()
    )
  )
);