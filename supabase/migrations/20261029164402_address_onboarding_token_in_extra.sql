-- The link an account arrived by lives in extra.onboarding_token_id. Moved
-- without the organization's webhooks or updated_at hearing of it: nothing
-- about the account changed.
alter table "public"."organizations_addresses" disable trigger "z_notify_webhook_organizations_addresses";
alter table "public"."organizations_addresses" disable trigger "set_updated_at";

update "public"."organizations_addresses"
set extra = coalesce(extra, '{}'::jsonb)
  || jsonb_build_object('onboarding_token_id', onboarding_token_id)
where onboarding_token_id is not null;

alter table "public"."organizations_addresses" enable trigger "z_notify_webhook_organizations_addresses";
alter table "public"."organizations_addresses" enable trigger "set_updated_at";

alter table "public"."organizations_addresses" drop column "onboarding_token_id";
