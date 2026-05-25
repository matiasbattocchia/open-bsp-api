-- Create organization_secrets table for secure token storage
create table if not exists public.organization_secrets (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  address text not null,
  key text not null,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, address, key)
);

alter table public.organization_secrets enable row level security;

-- No SELECT policy for authenticated — only service_role can read

-- Migrate existing access_tokens from organizations_addresses.extra
insert into public.organization_secrets (organization_id, address, key, value)
select
  organization_id,
  address,
  'access_token',
  extra->>'access_token'
from public.organizations_addresses
where extra->>'access_token' is not null
  and extra->>'access_token' != ''
on conflict do nothing;

-- Remove access_token from extra JSONB
update public.organizations_addresses
set extra = extra - 'access_token'
where extra->>'access_token' is not null;
