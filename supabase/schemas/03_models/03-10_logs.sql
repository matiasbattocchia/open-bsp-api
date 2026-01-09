create type public.log_level as enum ('info', 'warning', 'error');

create table public.logs (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  organization_address text,
  foreign key (organization_id, organization_address) references public.organizations_addresses(organization_id, address) on delete cascade,
  level public.log_level not null,
  category text not null,
  message text not null,
  metadata jsonb,
  created_at timestamp with time zone not null default now()
);

alter table only public.logs
add constraint logs_pkey
primary key (id);

create index idx_logs_address
on public.logs
using btree (organization_address);

create index idx_logs_created_at
on public.logs
using btree (created_at desc);

create index idx_logs_org_id
on public.logs
using btree (organization_id);

create trigger lookup_org_address
before insert on public.logs
for each row
execute function public.before_insert_on_logs();