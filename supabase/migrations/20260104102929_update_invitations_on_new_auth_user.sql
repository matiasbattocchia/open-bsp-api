drop trigger if exists "handle_new_invitation" on "public"."agents";

drop function if exists "public"."lookup_user_id_by_email"();

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.lookup_agents_by_email_after_insert_on_auth_users()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Update invitations matching the new user's email
  update public.agents
  set user_id = new.id
  where user_id is null
    and extra->'invitation'->>'email' = new.email;
  
  return new;
end;
$function$
;

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

CREATE OR REPLACE FUNCTION public.enforce_invitation_status_flow()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if old.extra->'invitation' is not null then -- invitation
    if new.extra->'invitation' is null then -- invitation removed
      raise exception 'Cannot remove invitation';
    end if;

    if new.extra->'invitation'->>'email' is distinct from old.extra->'invitation'->>'email' then
      raise exception 'Cannot change invitation email';
    end if;

    if old.extra->'invitation'->>'status' is distinct from new.extra->'invitation'->>'status' then
      if old.extra->'invitation'->>'status' <> 'pending' then
        raise exception 'Cannot change invitation status from %', old.extra->'invitation'->>'status';
      end if;
    
      if new.extra->'invitation'->>'status' not in ('accepted', 'rejected') then
        raise exception 'Invitation status can only be changed to accepted or rejected';
      end if;
    end if;
  else -- no invitation; original owner
    if new.extra->'invitation' is not null then
      raise exception 'Cannot add invitation to existing agent';
    end if;
  end if;

  return new;
end;
$function$
;

CREATE TRIGGER handle_new_invitation BEFORE INSERT ON public.agents FOR EACH ROW WHEN (((new.ai = false) AND ((new.extra -> 'invitation'::text) IS NOT NULL))) EXECUTE FUNCTION public.lookup_user_id_by_email_before_insert_on_agents();

CREATE TRIGGER handle_new_auth_user AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.lookup_agents_by_email_after_insert_on_auth_users();


