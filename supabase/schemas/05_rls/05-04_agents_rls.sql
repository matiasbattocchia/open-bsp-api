alter table public.agents enable row level security;

create policy "members can read themselves"
on public.agents
for select
to authenticated
using (
  user_id = auth.uid()
);

create policy "members can update themselves"
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
  and ai = false
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

create policy "members can read their orgs agents"
on public.agents
for select
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
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

create policy "owners can create their orgs ai agents and send invitations"
on public.agents
for insert
to authenticated
with check (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
  and (
    ai = true
    or (
      ai = false
      and extra->'invitation'->>'status' = 'pending'
      and extra->'invitation'->>'email' is not null
    )
  )
);

create policy "owners can update their orgs agents"
on public.agents
for update
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
)
with check (
  user_id = (
    select user_id from public.agents as a where a.id = id
  )
  and organization_id = (
    select organization_id from public.agents as a where a.id = id
  )
  and ai = (
    select ai from public.agents as a where a.id = id
  )
  and extra->'invitation' = (
    select extra->'invitation' from public.agents as a where a.id = id
  )
);

create policy "owners can delete their orgs agents"
on public.agents
for delete
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);