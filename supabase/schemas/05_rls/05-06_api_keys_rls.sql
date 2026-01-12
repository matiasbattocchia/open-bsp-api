alter table public.api_keys enable row level security;

create policy "owners can read their orgs api keys"
on public.api_keys
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);

create policy "owners can create their orgs api keys"
on public.api_keys
for insert
to authenticated, anon
with check (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);

create policy "owners can delete their orgs api keys"
on public.api_keys
for delete
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);