alter table public.organizations enable row level security;

create policy "users can create orgs"
on public.organizations
for insert
to authenticated -- orgs cannot be created by api keys
with check (
  true
);

create policy "members can read their orgs"
on public.organizations
for select
to authenticated, anon
using (
  id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "admins can update their orgs, without changing their name"
on public.organizations
for update
to authenticated, anon
using (
  id in (
    select public.get_authorized_orgs('admin')
  )
)
with check (
  id in (
    select public.get_authorized_orgs('admin')
  )
  and public.org_update_by_admin_rules(id, name)
);

create policy "owners can delete their orgs"
on public.organizations
for delete
to authenticated, anon
using (
  id in (
    select public.get_authorized_orgs('owner')
  )
);