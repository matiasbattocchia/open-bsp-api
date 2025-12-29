alter table public.contacts enable row level security;

create policy "members can manage their orgs contacts"
on public.contacts
for all
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);