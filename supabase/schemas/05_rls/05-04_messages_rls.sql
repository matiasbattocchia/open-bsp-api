alter table public.messages enable row level security;

-- Note: messages cannot be edited or deleted by the user.

create policy "members can read their orgs messages"
on public.messages
for select
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "members can create their orgs messages"
on public.messages
for insert
to authenticated
with check (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "anonymous can read messages with valid api key"
on public.messages
for select
to anon
using (
  organization_id in (
    select public.get_authorized_org_by_api_key()
  )
);

create policy "anonymous can create messages with valid api key"
on public.messages
for insert
to anon
with check (
  organization_id in (
    select public.get_authorized_org_by_api_key()
  )
);
