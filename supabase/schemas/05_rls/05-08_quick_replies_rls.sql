alter table public.quick_replies enable row level security;

create policy "org members can manage their org quick replies"
on public.quick_replies
for all
to authenticated
using (
  organization_id in (
    select public.get_authorized_orgs()
  )
);
