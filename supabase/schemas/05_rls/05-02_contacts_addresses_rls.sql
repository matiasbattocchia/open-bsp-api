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