alter table public.organizations_addresses enable row level security;

-- Note: organizations addresses are read only. They are managed by the system.

create policy "members can read their orgs addresses"
on public.organizations_addresses
for select
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "anonymous can read addresses with valid api key"
on public.organizations_addresses
for select
to anon
using (
  organization_id = (
    select public.get_authorized_org_by_api_key()
  )
);