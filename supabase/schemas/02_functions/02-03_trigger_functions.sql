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

create function public.before_insert_on_messages() returns trigger
language plpgsql
as $$
begin
  -- If conversation_id is already provided, proceed as is
  if new.conversation_id is not null then
    return new;
  end if;

  -- Look up conversation_id from conversation table
  select id into new.conversation_id
  from public.conversations
  where organization_address = new.organization_address
    and contact_address is not distinct from new.contact_address
    and group_address is not distinct from new.group_address
    and status = 'active'
  order by created_at desc
  limit 1;

  -- Create conversation if it doesn't exist
  if new.conversation_id is null then
    insert into public.conversations (
      organization_id,
      organization_address,
      contact_address,
      group_address,
      service
    ) values (
      new.organization_id,
      new.organization_address,
      new.contact_address,
      new.group_address,
      new.service
    )
    returning id into new.conversation_id;
  end if;

  return new;
end;
$$;

create function public.manage_contact_on_address_sync() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _contact_id_to_check uuid;
  _other_active_count int;
begin
  -- Case 1: Synced Action = ADD
  if new.extra->'synced'->>'action' = 'add' then
    -- Check if we can reuse existing contact from OLD (if updating)
    if (TG_OP = 'UPDATE') and old.contact_id is not null then
      new.contact_id := old.contact_id;
    end if;

    -- If still no contact linked, create one
    if new.contact_id is null then
      insert into public.contacts (
        organization_id,
        name
      ) values (
        new.organization_id,
        new.extra->'synced'->>'name'
      ) returning id into new.contact_id;
    end if;
    
    return new;
  end if;

  -- Case 2: Synced Action = REMOVE
  if new.extra->'synced'->>'action' = 'remove' then
    -- Identify the contact we might be orphaning (from OLD state)
    _contact_id_to_check := old.contact_id;

    -- If there was a contact linked, check if it becomes orphaned
    if _contact_id_to_check is not null then
       -- Count OTHER active addresses for this contact
       select count(*) into _other_active_count
       from public.contacts_addresses
       where contact_id = _contact_id_to_check
         and status = 'active'
         -- Exclude the current address being processed
         and not (organization_id = new.organization_id and address = new.address);
       
       -- If no other addresses reference it, delete the contact
       if _other_active_count = 0 then
         delete from public.contacts where id = _contact_id_to_check;
       end if;
    end if;

    -- Check if we should delete this address (no conversations)
    if not exists (
      select 1 from public.conversations c 
      where c.organization_id = new.organization_id 
        and c.contact_address = new.address
    ) then
      -- Delete self and cancel update
      delete from public.contacts_addresses
      where organization_id = new.organization_id
        and address = new.address;
      return null; 
    end if;

    -- Otherwise, just unlink
    new.contact_id := null;
    return new;
  end if;

  return new;
end;
$$;


create or replace function public.cleanup_addresses_before_contact_delete()
returns trigger
language plpgsql
as $$
begin
  -- Delete addresses linked to this contact that have NO conversations
  delete from public.contacts_addresses ca
  where ca.contact_id = old.id
    and not exists (
      select 1 from public.conversations c
      where c.organization_id = ca.organization_id
        and c.contact_address = ca.address
    )
    -- Do not delete synced addresses (externally managed)
    and not (ca.extra ? 'synced');
  
  -- Remaining addresses will have contact_id set to NULL (via ON DELETE SET NULL FK)
  -- because they have history (conversations) and must be preserved.
  
  return old;
end;
$$;

create function public.before_insert_on_conversations() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _existing_address text;
begin
  -- Validate that external services require either contact_address or group_address
  if new.service <> 'local' and new.contact_address is null and new.group_address is null then
    raise exception 'Conversations with external services require either contact_address or group_address';
  end if;

  if new.contact_address is null then
    return new;
  end if;

  select address into _existing_address
  from public.contacts_addresses
  where organization_id = new.organization_id
    and address = new.contact_address
  order by created_at desc
  limit 1;

  if _existing_address is null then
    insert into public.contacts_addresses (
      organization_id,
      address,
      service
    ) values (
      new.organization_id,
      new.contact_address,
      new.service
    );
  end if;

  return new;
end;
$$;

create function public.pause_conversation_on_human_message() returns trigger
language plpgsql
set search_path = ''
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

create function public.notify_webhook() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  webhook_record record;
  headers jsonb;
begin
  -- loop through all matching webhooks
  for webhook_record in
    select w.url, w.token
    from public.webhooks w
    where new.organization_id = w.organization_id
      and w.table_name = tg_table_name::public.webhook_table
      and lower(tg_op)::public.webhook_operation = any(w.operations)
    limit 3
  loop
    -- prepare headers
    headers := case
      when webhook_record.token is not null then
        jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || webhook_record.token
        )
      else
        jsonb_build_object(
          'content-type', 'application/json'
        )
      end;

    -- send webhook notification
    perform net.http_post(
      url := webhook_record.url,
      body := jsonb_build_object(
        'data', to_jsonb(new),
        'entity', tg_table_name,
        'action', lower(tg_op)
      ),
      headers := headers
    );
  end loop;

  return new;
end;
$$;
