alter table public.contacts_addresses enable row level security;

create policy "org members can read their orgs contacts addresses"
on public.contacts_addresses
for select
to authenticated
using (
  contact_id in (
    select id from public.contacts where organization_id in (
      select public.get_authorized_orgs()
    )
  )
);
