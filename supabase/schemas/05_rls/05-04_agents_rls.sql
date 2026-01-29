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
  public.member_self_update_rules(id, user_id, organization_id, ai, extra)
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
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "admins can manage their orgs ai agents"
on public.agents
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
  and user_id is null
  and ai = true
);

create policy "admins can create their orgs ai agents"
on public.agents
for insert
to authenticated, anon
with check (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
  and ai = true
);

create policy "owners can send invitations"
on public.agents
for insert
to authenticated, anon
with check (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
  and ai = false
  and extra->'invitation'->>'status' = 'pending'
  and extra->'invitation'->>'email' is not null
);

create policy "owners can update their orgs agents"
on public.agents
for update
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
)
with check (
  public.agent_update_by_owner_rules(id, user_id, organization_id, ai, extra)
);

create policy "owners can delete their orgs agents"
on public.agents
for delete
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('owner')
  )
);