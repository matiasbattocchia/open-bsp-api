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
  existing_status text;
  existing_contact_id uuid;
begin
  -- Check most recent conversation for same organization and contact addresses
  select status, contact_id into existing_status, existing_contact_id
  from public.conversations
  where organization_address = new.organization_address
    and contact_address = new.contact_address
  order by created_at desc
  limit 1;

  -- If an active conversation exists, skip insertion
  if existing_status = 'active' then
    return null;
  end if;

  -- Look up organization_id if missing
  if new.organization_id is null then
    select organization_id into new.organization_id
    from public.organizations_addresses
    where address = new.organization_address;
  end if;

  -- Reuse contact_id from most recent conversation if missing
  if new.contact_id is null then
    new.contact_id := existing_contact_id;
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

  -- Raise error if conversation does not exist
  if new.conversation_id is null then
    raise exception 'Active conversation not found for organization_address % and contact_address %',
      new.organization_address, new.contact_address;
  end if;

  return new;
end;
$$;

create function public.bulk_update_messages_status(records jsonb) returns void
language plpgsql
set search_path to ''
as $$
begin
  update messages o
  set status = r.status
  from (
    select * from jsonb_populate_recordset(null::messages, records)
  ) r
  where o.external_id = r.external_id;
end;
$$;
