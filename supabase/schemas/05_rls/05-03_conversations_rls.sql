alter table public.conversations enable row level security;

create policy "members can manage their orgs conversations"
on public.conversations
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);