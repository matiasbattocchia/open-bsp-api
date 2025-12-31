drop policy "members can update themselves, without changing their org nor r" on "public"."agents";

drop policy "owners can manage their orgs agents" on "public"."agents";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.check_org_limit_before_create_org()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  current_user_id uuid := auth.uid();
  org_count int;
begin
  if current_user_id is null then
    return new;
  end if;

  select count(*) into org_count
  from public.agents
  where user_id = current_user_id
  and (
    extra->'invitation' is null
    or extra->'invitation'->>'status' = 'accepted'
  );

  if org_count >= 9 then
    raise exception 'User cannot be a member of more than 9 organizations';
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.check_org_limit_before_update_agent()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  org_count int;
begin
  select count(*) into org_count
  from public.agents
  where user_id = new.user_id
  and (
    extra->'invitation' is null
    or extra->'invitation'->>'status' = 'accepted'
  );

  if org_count >= 9 then
    raise exception 'User cannot be a member of more than 9 organizations';
  end if;

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

CREATE OR REPLACE FUNCTION public.handle_invitation_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  select id into new.user_id
  from auth.users
  where email = new.extra->'invitation'->>'email';
  
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.prevent_last_owner_deletion()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  owner_count int;
begin
  -- Skip check if org is being deleted (cascade delete)
  if not exists (
    select 1 from public.organizations
    where id = old.organization_id
    for update skip locked
  ) then
    return old;
  end if;

  if old.extra->>'role' = 'owner' then
    select count(*) into owner_count
    from public.agents
    where organization_id = old.organization_id
      and extra->>'role' = 'owner'
      and id <> old.id;

    if owner_count = 0 then
      raise exception 'Cannot delete the last owner of an organization';
    end if;
  end if;

  return old;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_organization()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  user_id uuid := auth.uid();
  user_name text;
begin
  insert into public.organizations_addresses (organization_id, service, address)
    values (new.id, 'local', new.id::text);

  if user_id is not null then
    select coalesce(raw_user_meta_data->>'full_name', email, '?') into user_name
    from auth.users
    where id = user_id;

    insert into public.agents (organization_id, user_id, name, ai, extra)
    values (new.id, user_id, user_name, false, '{"role": "owner"}');
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_authorized_orgs(role text DEFAULT 'member'::text)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  req_level int;
begin
  req_level := case role
    when 'owner' then 3
    when 'admin' then 2
    else 1 -- 'member'
  end;

  return query select organization_id from public.agents
  where
    user_id = auth.uid()
  and (
    extra->'invitation' is null
    or extra->'invitation'->>'status' = 'accepted'
  )
  and (
    case (extra->>'role')
      when 'owner' then 3
      when 'admin' then 2
      else 1 -- 'member'
    end
  ) >= req_level;
end;
$function$
;


  create policy "members can read themselves"
  on "public"."agents"
  as permissive
  for select
  to authenticated
using ((user_id = auth.uid()));



  create policy "members can update themselves"
  on "public"."agents"
  as permissive
  for update
  to authenticated
using ((user_id = auth.uid()))
with check (((user_id = auth.uid()) AND (organization_id = ( SELECT a.organization_id
   FROM public.agents a
  WHERE (a.id = a.id))) AND (ai = false) AND ((extra ->> 'role'::text) = ( SELECT (a.extra ->> 'role'::text)
   FROM public.agents a
  WHERE (a.id = a.id)))));



  create policy "owners can create their orgs ai agents and send invitations"
  on "public"."agents"
  as permissive
  for insert
  to authenticated
with check (((organization_id IN ( SELECT public.get_authorized_orgs('owner'::text) AS get_authorized_orgs)) AND ((ai = true) OR ((ai = false) AND (((extra -> 'invitation'::text) ->> 'status'::text) = 'pending'::text) AND (((extra -> 'invitation'::text) ->> 'email'::text) IS NOT NULL)))));



  create policy "owners can delete their orgs agents"
  on "public"."agents"
  as permissive
  for delete
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::text) AS get_authorized_orgs)));



  create policy "owners can update their orgs agents"
  on "public"."agents"
  as permissive
  for update
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::text) AS get_authorized_orgs)))
with check (((user_id = ( SELECT a.user_id
   FROM public.agents a
  WHERE (a.id = a.id))) AND (organization_id = ( SELECT a.organization_id
   FROM public.agents a
  WHERE (a.id = a.id))) AND (ai = ( SELECT a.ai
   FROM public.agents a
  WHERE (a.id = a.id))) AND ((extra -> 'invitation'::text) = ( SELECT (a.extra -> 'invitation'::text)
   FROM public.agents a
  WHERE (a.id = a.id)))));


CREATE TRIGGER check_org_limit_before_update_agent BEFORE UPDATE ON public.agents FOR EACH ROW WHEN (((new.ai = false) AND (new.user_id IS NOT NULL) AND (((old.extra -> 'invitation'::text) ->> 'status'::text) <> 'accepted'::text) AND (((new.extra -> 'invitation'::text) ->> 'status'::text) = 'accepted'::text))) EXECUTE FUNCTION public.check_org_limit_before_update_agent();

CREATE TRIGGER enforce_invitation_status_flow BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.enforce_invitation_status_flow();

CREATE TRIGGER handle_invitation_insert BEFORE INSERT ON public.agents FOR EACH ROW WHEN (((new.ai = false) AND ((new.extra -> 'invitation'::text) IS NOT NULL))) EXECUTE FUNCTION public.handle_invitation_insert();

CREATE TRIGGER prevent_last_owner_deletion BEFORE DELETE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.prevent_last_owner_deletion();

CREATE TRIGGER check_org_limit_before_create_org BEFORE INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.check_org_limit_before_create_org();


