alter table public.logs enable row level security;

-- Org members can read their own org's logs (Meta management events: account
-- updates, history/signup errors). No secrets are stored in logs.metadata.
create policy "members can read their orgs logs"
on public.logs
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);
