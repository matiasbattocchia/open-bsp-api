alter table public.quick_replies enable row level security;

create policy "members can read their orgs quick replies"
on public.quick_replies
for select
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "admins can manage their orgs quick replies"
on public.quick_replies
for all
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
);
