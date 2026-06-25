drop trigger if exists "notify_webhook_conversations" on "public"."conversations";

drop trigger if exists "notify_webhook_messages" on "public"."messages";

drop policy "owners can create onboarding tokens" on "public"."onboarding_tokens";

drop policy "owners can delete onboarding tokens" on "public"."onboarding_tokens";

drop policy "owners can read their org onboarding tokens" on "public"."onboarding_tokens";

alter table "public"."onboarding_tokens" drop constraint "onboarding_tokens_created_by_fkey";

alter type "public"."webhook_table" rename to "webhook_table__old_version_to_be_dropped";

create type "public"."webhook_table" as enum ('messages', 'conversations', 'organizations_addresses', 'contacts', 'contacts_addresses', 'logs');

alter table "public"."webhooks" alter column table_name type "public"."webhook_table" using table_name::text::"public"."webhook_table";

drop type "public"."webhook_table__old_version_to_be_dropped";

alter table "public"."logs" add column "service" public.service;

alter table "public"."onboarding_tokens" drop column "created_by";

alter table "public"."onboarding_tokens" add column "callback_url" text;

alter table "public"."onboarding_tokens" add column "verify_token" text;

create policy "members can read their orgs logs"
on "public"."logs"
as permissive
for select
to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));

create policy "owners can create onboarding tokens"
on "public"."onboarding_tokens"
as permissive
for insert
to authenticated, anon
with check ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));

create policy "owners can delete onboarding tokens"
on "public"."onboarding_tokens"
as permissive
for delete
to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));

create policy "owners can read their org onboarding tokens"
on "public"."onboarding_tokens"
as permissive
for select
to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));

-- notify_webhook triggers are named with a z_ prefix so they fire LAST among
-- each table's AFTER-row triggers (Postgres fires them in alphabetical order) —
-- the webhook is the final signal, after billing/dispatch/cleanup side effects.
CREATE TRIGGER z_notify_webhook_contacts AFTER INSERT OR UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.notify_webhook();

CREATE TRIGGER z_notify_webhook_contacts_addresses AFTER INSERT OR UPDATE ON public.contacts_addresses FOR EACH ROW EXECUTE FUNCTION public.notify_webhook();

CREATE TRIGGER z_notify_webhook_conversations AFTER INSERT OR UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.notify_webhook();

CREATE TRIGGER z_notify_webhook_logs AFTER INSERT ON public.logs FOR EACH ROW EXECUTE FUNCTION public.notify_webhook();

CREATE TRIGGER z_notify_webhook_messages AFTER INSERT OR UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.notify_webhook();

CREATE TRIGGER z_notify_webhook_organizations_addresses AFTER INSERT OR UPDATE ON public.organizations_addresses FOR EACH ROW EXECUTE FUNCTION public.notify_webhook();

-- Data backfill — db diff emits only schema, so this DML is hand-written (and
-- you explicitly asked for it): set service on existing log rows from their
-- category, then rename the instagram_login category to the service-scoped
-- 'login'.
update public.logs set service = 'instagram'
where service is null and category in ('instagram_login', 'instagram_token_refresh');

update public.logs set service = 'whatsapp'
where service is null and category in ('signup', 'history', 'account_update');

update public.logs set category = 'login' where category = 'instagram_login';
