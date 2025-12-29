alter table public.agents enable row level security;

create policy "members can read their orgs agents"
on public.agents
for select
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "members can update themselves, without changing their org nor role"
on public.agents
for update
to authenticated
using (
  user_id = auth.uid()
)
with check (
  user_id = auth.uid()
  and organization_id = (
    select organization_id from public.agents as a where a.id = id
  )
  and extra->>'role' = (
    select extra->>'role' from public.agents as a where a.id = id
  )
);

create policy "members can delete themselves"
on public.agents
for delete
to authenticated
using (
  user_id = auth.uid()
);

create policy "admins can manage their orgs ai agents"
on public.agents
for all
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
  and user_id is null
  and ai = true
);

create policy "owners can manage their orgs agents"
on public.agents
for all
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);