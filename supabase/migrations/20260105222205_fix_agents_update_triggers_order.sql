drop trigger if exists "enforce_invitation_status_flow" on "public"."agents";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.lookup_user_id_by_email_before_insert_on_agents()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Check if an invitation already exists for this email in this org
  if exists (
    select 1
    from public.agents
    where organization_id = new.organization_id
      and extra->'invitation'->>'email' = new.extra->'invitation'->>'email'
  ) then
    raise exception 'An invitation for this email already exists in this organization';
  end if;

  -- Associate user_id to the agent
  select id into new.user_id
  from auth.users
  where email = new.extra->'invitation'->>'email';
  
  return new;
end;
$function$
;

CREATE TRIGGER z_enforce_invitation_status_flow BEFORE UPDATE ON public.agents FOR EACH ROW WHEN ((new.ai = false)) EXECUTE FUNCTION public.enforce_invitation_status_flow();


