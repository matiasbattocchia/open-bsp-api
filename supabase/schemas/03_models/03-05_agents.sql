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
