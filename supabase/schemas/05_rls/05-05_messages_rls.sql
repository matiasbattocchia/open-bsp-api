alter table public.messages enable row level security;

-- Note: messages cannot be edited or deleted by the user.

create policy "members can read their orgs messages"
on public.messages
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "members can create their orgs messages"
on public.messages
for insert
to authenticated, anon
with check (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);
