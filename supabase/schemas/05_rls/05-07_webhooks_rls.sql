alter table public.webhooks enable row level security;

create policy "admins can manage their orgs webhooks"
on public.webhooks
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
);