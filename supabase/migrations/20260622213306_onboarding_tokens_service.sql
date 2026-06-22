-- Add onboarding_tokens.service. The column is NOT NULL with no default, so add
-- it nullable first, backfill existing tokens to 'whatsapp' (the only service
-- onboarding tokens existed for before this), then enforce NOT NULL.
alter table public.onboarding_tokens add column service public.service;

update public.onboarding_tokens set service = 'whatsapp' where service is null;

alter table public.onboarding_tokens alter column service set not null;
