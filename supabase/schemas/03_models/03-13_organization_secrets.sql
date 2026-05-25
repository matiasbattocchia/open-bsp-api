-- Stores sensitive credentials (access tokens, API keys) for organization integrations.
-- This table is NOT accessible from the frontend — only service_role can read/write.
create table public.organization_secrets (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  address text not null,
  key text not null,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, address, key)
);

-- No RLS select policy for authenticated users — only service_role bypasses RLS
alter table public.organization_secrets enable row level security;

-- Trigger to auto-update updated_at
create trigger set_updated_at
before update on public.organization_secrets
for each row
execute function extensions.moddatetime('updated_at');
