alter table public.messages enable row level security;

create policy "org members can manage their orgs messages"
on public.messages
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

create policy "anonymous can manage messages with valid api key"
on public.messages
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