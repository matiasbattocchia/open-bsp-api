alter table public.conversations enable row level security;

create policy "org members can manage their orgs conversations"
on public.conversations
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs()
  )
);

create policy "anonymous can manage conversations with valid api key"
on public.conversations
to anon
using (
  organization_id = (
    select public.get_authorized_org_by_api_key()
  )
); 