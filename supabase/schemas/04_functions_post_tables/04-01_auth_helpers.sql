create function public.get_authorized_org_by_api_key() returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  api_key text := current_setting('request.headers', true)::json->>'x-app-api-key';
  org_id uuid;
begin
  select organization_id from public.api_keys where key = api_key into org_id;

  if org_id is not null then
    return org_id;
  end if;

  raise exception using
    errcode = '42501',
    message = 'no registered api key found in x-app-api-key header';
end;
$$;

create function public.get_authorized_orgs(role text default 'member') returns setof uuid
language plpgsql
security definer
set search_path to ''
as $$
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
$$;

-- Check if agent immutable fields match the original (for UPDATE policies)
create function public.agent_update_by_owner_rules(
  p_id uuid,
  p_user_id uuid,
  p_organization_id uuid,
  p_ai boolean,
  p_extra jsonb
) returns boolean
language plpgsql
security definer -- avoid RLS infinite recursion
set search_path to ''
as $$
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
$$;

-- Check if org and role are unchanged (for member self-update)
create function public.member_self_update_rules(
  p_id uuid,
  p_user_id uuid,
  p_organization_id uuid,
  p_ai boolean,
  p_extra jsonb
) returns boolean
language plpgsql
security definer -- avoid RLS infinite recursion
set search_path to ''
as $$
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
$$;