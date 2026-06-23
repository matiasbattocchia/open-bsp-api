alter table public.conversation_labels enable row level security;

create policy "members can read their orgs conversation labels"
on public.conversation_labels
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "members can manage their orgs conversation labels"
on public.conversation_labels
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
)
with check (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);
