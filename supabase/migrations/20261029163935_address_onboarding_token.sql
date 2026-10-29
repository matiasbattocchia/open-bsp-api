alter table "public"."organizations_addresses" add column "onboarding_token_id" uuid;

-- Backfill: an account created within two minutes of a link being used, in
-- the link's organization and service, arrived by it (the closest link, when
-- two are that near). A link that reconnected an existing account left no such
-- trace, and stays unknown. Neither the organization's webhooks nor updated_at
-- hear of it: nothing about the account changed.
alter table "public"."organizations_addresses" disable trigger "z_notify_webhook_organizations_addresses";
alter table "public"."organizations_addresses" disable trigger "set_updated_at";

update "public"."organizations_addresses" a
set onboarding_token_id = m.token_id
from (
  select distinct on (a.organization_id, a.service, a.address)
    a.organization_id, a.service, a.address, t.id as token_id
  from "public"."organizations_addresses" a
  join "public"."onboarding_tokens" t
    on t.organization_id = a.organization_id
    and t.service = a.service
    and t.status = 'used'
    and abs(extract(epoch from a.created_at - t.used_at)) < 120
  order by a.organization_id, a.service, a.address,
    abs(extract(epoch from a.created_at - t.used_at))
) m
where a.organization_id = m.organization_id
  and a.service = m.service
  and a.address = m.address;

alter table "public"."organizations_addresses" enable trigger "z_notify_webhook_organizations_addresses";
alter table "public"."organizations_addresses" enable trigger "set_updated_at";
