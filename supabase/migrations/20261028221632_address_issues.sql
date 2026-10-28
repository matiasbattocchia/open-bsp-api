alter table "public"."organizations_addresses" add column "issue" jsonb;

alter table "public"."organizations_addresses" add constraint "organizations_addresses_issue_reason" CHECK (((issue IS NULL) OR ((issue ->> 'reason'::text) = ANY (ARRAY['logged_out'::text, 'banned'::text, 'expired'::text])))) not valid;

alter table "public"."organizations_addresses" validate constraint "organizations_addresses_issue_reason";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.clear_address_issue()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.issue := null;
  return new;
end;
$function$
;

CREATE TRIGGER clear_issue BEFORE UPDATE ON public.organizations_addresses FOR EACH ROW WHEN (((old.status <> 'connected'::text) AND (new.status = 'connected'::text))) EXECUTE FUNCTION public.clear_address_issue();

CREATE TRIGGER notify_address_issue AFTER UPDATE ON public.organizations_addresses FOR EACH ROW WHEN (((new.issue IS NOT NULL) AND (old.issue IS DISTINCT FROM new.issue))) EXECUTE FUNCTION public.edge_function('/notifications', 'post');


