-- Check org limit before user becomes active member (invitation accepted)
create function public.check_org_limit_before_update_on_agents() returns trigger
language plpgsql
set search_path to ''
as $$
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
$$;

-- Check org limit before creating org (prevents orphaned orgs)
create function public.check_org_limit_before_insert_on_organizations() returns trigger
language plpgsql
set search_path to ''
as $$
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
$$;

create function public.lookup_user_id_by_email_before_insert_on_agents() returns trigger
language plpgsql
security definer -- bypass RLS to access auth.users
set search_path to ''
as $$
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
$$;

-- Auto-associate user_id to agents when new user signs up
create function public.lookup_agents_by_email_after_insert_on_auth_users() returns trigger
language plpgsql
security definer -- bypass RLS to update agents table
set search_path to ''
as $$
begin
  -- Update invitations matching the new user's email
  update public.agents
  set user_id = new.id
  where user_id is null
    and extra->'invitation'->>'email' = new.email;
  
  return new;
end;
$$;

-- Enforce invitation status flow: pending → accepted/rejected only
create function public.enforce_invitation_status_flow() returns trigger
language plpgsql
set search_path to ''
as $$
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
$$;

-- Create local address and owner agent after org creation
create function public.after_insert_on_organizations() returns trigger
language plpgsql
security definer -- bypass RLS to create the first owner
set search_path to ''
as $$
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
$$;

-- Prevent deletion of the last owner in an organization
create function public.prevent_last_owner_deletion() returns trigger
language plpgsql
set search_path to ''
as $$
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
$$;

create function public.before_insert_on_conversations() returns trigger
language plpgsql
as $$
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
$$;

create function public.before_insert_on_messages() returns trigger
language plpgsql
as $$
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
$$;

create function public.pause_conversation_on_human_message() returns trigger
language plpgsql
as $$
declare
  agent_is_ai boolean;
begin
  -- Check if message is from a human (null agent_id or agent with ai = false)
  if new.agent_id is not null then
    select ai into agent_is_ai
    from public.agents
    where id = new.agent_id;

    -- If agent exists and is AI, don't pause
    if agent_is_ai = true then
      return new;
    end if;
  end if;

  update public.conversations
  set extra = jsonb_build_object('paused', now())
  where id = new.conversation_id;

  return new;
end;
$$;

create function public.before_insert_on_logs() returns trigger
language plpgsql
as $$
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
$$;
