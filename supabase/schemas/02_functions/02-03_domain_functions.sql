create function public.create_organization() returns trigger
language plpgsql
as $$
declare
  org_id uuid := new.id;
  org_address text := org_id::text;
begin
  insert into public.organizations_addresses (organization_id, service, address)
    values (org_id, 'local', org_address);

  return new;
end;
$$;

create function public.create_conversation() returns trigger
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

create function public.create_message() returns trigger
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

create function public.create_log() returns trigger
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
