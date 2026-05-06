set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.lookup_agents_by_email_after_insert_on_auth_users()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Update invitations matching the new user's email (case-insensitive)
  update public.agents
  set user_id = new.id
  where user_id is null
    and lower(extra->'invitation'->>'email') = lower(new.email);

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
  -- Check if an invitation already exists for this email in this org (case-insensitive)
  if exists (
    select 1
    from public.agents
    where organization_id = new.organization_id
      and lower(extra->'invitation'->>'email') = lower(new.extra->'invitation'->>'email')
  ) then
    raise exception 'An invitation for this email already exists in this organization';
  end if;

  -- Associate user_id to the agent (auth.users.email is normalized to lowercase
  -- by Supabase, but compare case-insensitively in case the invitation email was
  -- entered with mixed case)
  select id into new.user_id
  from auth.users
  where lower(email) = lower(new.extra->'invitation'->>'email');

  return new;
end;
$function$
;
