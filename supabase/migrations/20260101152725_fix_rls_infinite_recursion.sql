drop trigger if exists "check_org_limit_before_update_agent" on "public"."agents";

drop trigger if exists "handle_invitation_insert" on "public"."agents";

drop trigger if exists "prevent_last_owner_deletion" on "public"."agents";

drop trigger if exists "create_log" on "public"."logs";

drop trigger if exists "check_org_limit_before_create_org" on "public"."organizations";

drop trigger if exists "enforce_invitation_status_flow" on "public"."agents";

drop trigger if exists "handle_new_conversation" on "public"."conversations";

drop trigger if exists "handle_new_message" on "public"."messages";

drop trigger if exists "handle_new_organization" on "public"."organizations";

drop policy "members can update themselves" on "public"."agents";

drop policy "owners can update their orgs agents" on "public"."agents";

drop function if exists "public"."check_org_limit_before_create_org"();

drop function if exists "public"."check_org_limit_before_update_agent"();

drop function if exists "public"."create_conversation"();

drop function if exists "public"."create_log"();

drop function if exists "public"."create_message"();

drop function if exists "public"."create_organization"();

drop function if exists "public"."handle_invitation_insert"();

alter table "public"."api_keys" add column "name" text not null;

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.after_insert_on_organizations()
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

CREATE OR REPLACE FUNCTION public.agent_update_by_owner_rules(p_id uuid, p_user_id uuid, p_organization_id uuid, p_ai boolean, p_extra jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return exists (
    select 1 from public.agents
    where id = p_id
      -- updating user_id is not allowed
      and user_id is not distinct from p_user_id
      -- prevent from smuggling into another org
      and organization_id = p_organization_id
      -- once created, ai/human cannot be changed
      and ai = p_ai
      -- sent invitations can only be updated by the receiver
      and extra->'invitation' is not distinct from p_extra->'invitation'
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.before_insert_on_conversations()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  recent_conv record;
begin
  -- Check most recent conversation for same organization and contact addresses
  select * into recent_conv
  from public.conversations
  where organization_address = new.organization_address
    and contact_address = new.contact_address
  order by created_at desc
  limit 1;

  -- If a conversation exists and old.name is null and new.name is not, then update
  -- all conversations with the same organization_address and contact_address.
  if recent_conv is not null and recent_conv.name is null and new.name is not null then
    update public.conversations
    set name = new.name
    where organization_address = new.organization_address
      and contact_address = new.contact_address;
  end if;

  -- If an active conversation exists, skip insertion
  if recent_conv.status = 'active' then
    return null;
  end if;

  if new.organization_id is null then
    -- Reuse organization_id from most recent conversation if missing
    if recent_conv.organization_id is not null then
      new.organization_id = recent_conv.organization_id;
    else
    -- Look up organization_id if missing
      select organization_id into new.organization_id
      from public.organizations_addresses
      where address = new.organization_address;
    end if;
  end if;

  -- Reuse name from most recent conversation if missing
  if new.name is null then
    new.name := recent_conv.name;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.before_insert_on_logs()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  waba_id text;
begin
  -- Try to find by organization_address first
  if new.organization_id is null and new.organization_address is not null then
    select organization_id into new.organization_id
    from public.organizations_addresses
    where address = new.organization_address;
  end if;

  -- If still null, try to find by waba_id in metadata
  if new.organization_id is null and new.metadata is not null then
    waba_id := coalesce(new.metadata->>'waba_id', new.metadata->'waba_info'->>'waba_id');
    
    if waba_id is not null then
      select organization_id, address into new.organization_id, new.organization_address
      from public.organizations_addresses
      where service = 'whatsapp' 
        and extra->>'waba_id' = waba_id
      order by updated_at desc
      limit 1;
    end if;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.before_insert_on_messages()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- If both organization_id and conversation_id already provided, proceed as is
  if new.organization_id is not null and new.conversation_id is not null then
    return new;
  end if;

  -- Look up both organization_id and conversation_id from conversation table
  select organization_id, id into new.organization_id, new.conversation_id
  from public.conversations
  where organization_address = new.organization_address
    and contact_address = new.contact_address
    and status = 'active'
  order by created_at desc
  limit 1;

  -- Create conversation if it doesn't exist (create_conversation trigger will handle organization_id lookup)
  if new.conversation_id is null then
    insert into public.conversations (
      organization_address,
      contact_address,
      service
    ) values (
      new.organization_address,
      new.contact_address,
      new.service
    )
    returning id, organization_id into new.conversation_id, new.organization_id;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.check_org_limit_before_insert_on_organizations()
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

CREATE OR REPLACE FUNCTION public.check_org_limit_before_update_on_agents()
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

CREATE OR REPLACE FUNCTION public.lookup_user_id_by_email()
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

CREATE OR REPLACE FUNCTION public.member_self_update_rules(p_id uuid, p_user_id uuid, p_organization_id uuid, p_ai boolean, p_extra jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return exists (
    select 1 from public.agents
    where id = p_id
      -- updating user_id is not allowed
      and user_id = p_user_id
      -- prevent member from smuggling into another org
      and organization_id = p_organization_id
      -- cannot change to ai
      and ai = p_ai
      -- only owners can change update members role
      and extra->>'role' = p_extra->>'role'
  );
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
      and (
        extra->>'invitation' is null
        or extra->'invitation'->>'status' = 'accepted'
      )
      and id <> old.id;

    if owner_count = 0 then
      raise exception 'Cannot delete the last owner of an organization';
    end if;
  end if;

  return old;
end;
$function$
;


  create policy "members can update themselves"
  on "public"."agents"
  as permissive
  for update
  to authenticated
using ((user_id = auth.uid()))
with check (public.member_self_update_rules(id, user_id, organization_id, ai, extra));



  create policy "owners can update their orgs agents"
  on "public"."agents"
  as permissive
  for update
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::text) AS get_authorized_orgs)))
with check (public.agent_update_by_owner_rules(id, user_id, organization_id, ai, extra));


CREATE TRIGGER check_org_limit BEFORE UPDATE ON public.agents FOR EACH ROW WHEN (((new.ai = false) AND (new.user_id IS NOT NULL) AND (((old.extra -> 'invitation'::text) ->> 'status'::text) <> 'accepted'::text) AND (((new.extra -> 'invitation'::text) ->> 'status'::text) = 'accepted'::text))) EXECUTE FUNCTION public.check_org_limit_before_update_on_agents();

CREATE TRIGGER handle_new_invitation BEFORE INSERT ON public.agents FOR EACH ROW WHEN (((new.ai = false) AND ((new.extra -> 'invitation'::text) IS NOT NULL))) EXECUTE FUNCTION public.lookup_user_id_by_email();

CREATE TRIGGER prevent_last_owner_deletion_before_delete BEFORE DELETE ON public.agents FOR EACH ROW WHEN (((old.ai = false) AND ((old.extra ->> 'role'::text) = 'owner'::text))) EXECUTE FUNCTION public.prevent_last_owner_deletion();

CREATE TRIGGER prevent_last_owner_deletion_before_update BEFORE UPDATE ON public.agents FOR EACH ROW WHEN (((new.ai = false) AND ((old.extra ->> 'role'::text) = 'owner'::text) AND ((new.extra ->> 'role'::text) <> 'owner'::text))) EXECUTE FUNCTION public.prevent_last_owner_deletion();

CREATE TRIGGER lookup_org_address BEFORE INSERT ON public.logs FOR EACH ROW EXECUTE FUNCTION public.before_insert_on_logs();

CREATE TRIGGER check_org_limit BEFORE INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.check_org_limit_before_insert_on_organizations();

CREATE TRIGGER enforce_invitation_status_flow BEFORE UPDATE ON public.agents FOR EACH ROW WHEN ((new.ai = false)) EXECUTE FUNCTION public.enforce_invitation_status_flow();

CREATE TRIGGER handle_new_conversation BEFORE INSERT ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.before_insert_on_conversations();

CREATE TRIGGER handle_new_message BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.before_insert_on_messages();

CREATE TRIGGER handle_new_organization AFTER INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.after_insert_on_organizations();


