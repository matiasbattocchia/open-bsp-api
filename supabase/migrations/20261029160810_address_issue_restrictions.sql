drop trigger if exists "notify_address_issue" on "public"."organizations_addresses";

alter table "public"."organizations_addresses" drop constraint "organizations_addresses_issue_reason";

alter table "public"."organizations_addresses" add constraint "organizations_addresses_issue_reason" CHECK (((issue IS NULL) OR ((issue ->> 'reason'::text) = ANY (ARRAY['logged_out'::text, 'banned'::text, 'expired'::text, 'removed'::text, 'offboarded'::text, 'deleted'::text, 'violation'::text, 'restricted'::text, 'locked'::text])))) not valid;

alter table "public"."organizations_addresses" validate constraint "organizations_addresses_issue_reason";

CREATE TRIGGER notify_address_issue AFTER UPDATE ON public.organizations_addresses FOR EACH ROW WHEN (((new.issue IS NOT NULL) AND (new.issue IS DISTINCT FROM old.issue) AND ((old.issue IS NULL) OR (((old.issue ->> 'until'::text))::timestamp with time zone < now())))) EXECUTE FUNCTION public.edge_function('/notifications', 'post');

