alter table public.labels enable row level security;

create policy "members can read their orgs labels"
on public.labels
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "admins can manage their orgs labels"
on public.labels
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
);
