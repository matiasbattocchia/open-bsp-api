alter table public.api_keys enable row level security;

create policy "admins can read their orgs api keys"
on public.api_keys
for select
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
);

create policy "admins can create their orgs api keys"
on public.api_keys
for insert
to authenticated
with check (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
);

create policy "admins can delete their orgs api keys"
on public.api_keys
for delete
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
); 