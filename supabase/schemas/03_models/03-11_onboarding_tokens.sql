create table public.onboarding_tokens (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  organization_id uuid not null,
  created_by uuid not null,
  created_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone not null,
  used_at timestamp with time zone,
  status text default 'active'::text not null,
  constraint onboarding_tokens_status_check check (status in ('active', 'used', 'expired'))
);

alter table only public.onboarding_tokens
add constraint onboarding_tokens_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.onboarding_tokens
add constraint onboarding_tokens_created_by_fkey
foreign key (created_by)
references auth.users(id);
