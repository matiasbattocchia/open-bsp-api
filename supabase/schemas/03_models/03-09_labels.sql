create table public.labels (
  name            text                     not null,
  organization_id uuid                     not null,
  color           text,
  created_at      timestamp with time zone not null default now()
);

alter table only public.labels
add constraint labels_pkey
primary key (name, organization_id);

alter table only public.labels
add constraint labels_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade
not valid;

create index labels_organization_idx
on public.labels
using btree (organization_id);
