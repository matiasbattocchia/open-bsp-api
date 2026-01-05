create table public.agents (
  organization_id uuid not null,
  user_id uuid,
  id uuid default gen_random_uuid() not null,
  name text not null,
  picture text,
  ai boolean not null,
  extra jsonb,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.agents
add constraint agents_organization_id_user_id_key
unique (organization_id, user_id);

alter table only public.agents
add constraint agents_pkey
primary key (id);

alter table only public.agents
add constraint agents_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.agents
add constraint agents_user_id_fkey
foreign key (user_id)
references auth.users(id)
on delete cascade;

create index agents_user_id_idx
on public.agents
using btree (user_id);

create trigger set_extra
before update
on public.agents
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

create trigger set_updated_at
before update
on public.agents
for each row
execute function public.moddatetime('updated_at');

create trigger handle_new_invitation
before insert
on public.agents
for each row
when (
  new.ai = false
  and new.extra->'invitation' is not null
)
execute function public.lookup_user_id_by_email_before_insert_on_agents();

-- should execute after set_extra
create trigger z_enforce_invitation_status_flow
before update
on public.agents
for each row
when (
  new.ai = false
)
execute function public.enforce_invitation_status_flow();

create trigger check_org_limit
before update
on public.agents
for each row
when (
  new.ai = false
  and new.user_id is not null
  and old.extra->'invitation'->>'status' != 'accepted'
  and new.extra->'invitation'->>'status' = 'accepted'
)
execute function public.check_org_limit_before_update_on_agents();

create trigger prevent_last_owner_deletion_before_update
before update
on public.agents
for each row
when (
  new.ai = false
  and old.extra->>'role' = 'owner'
  and new.extra->>'role' != 'owner'
)
execute function public.prevent_last_owner_deletion();

create trigger prevent_last_owner_deletion_before_delete
before delete
on public.agents
for each row
when (
  old.ai = false
  and old.extra->>'role' = 'owner'
)
execute function public.prevent_last_owner_deletion();
