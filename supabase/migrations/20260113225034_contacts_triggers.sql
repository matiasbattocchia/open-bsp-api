drop function if exists "public"."change_contact_address"(old_address text, new_address text);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.before_insert_on_contacts()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  _existing_id uuid;
  _existing_addresses jsonb;
  _new_addresses jsonb;
  _merged_addresses jsonb;
begin
  -- Extract addresses from new record
  _new_addresses := coalesce(new.extra->'addresses', '[]'::jsonb);
  
  -- Skip lookup if no addresses provided
  if jsonb_array_length(_new_addresses) = 0 then
    return new;
  end if;

  -- Look up existing contact by matching any address
  select id, coalesce(extra->'addresses', '[]'::jsonb) into _existing_id, _existing_addresses
  from public.contacts
  where organization_id = new.organization_id
    and extra->'addresses' ?| array(select jsonb_array_elements_text(_new_addresses))
  limit 1;

  -- If existing contact found, set id and merge addresses
  if _existing_id is not null then
    new.id := _existing_id;
    
    -- Merge addresses: combine existing and new, remove duplicates
    select jsonb_agg(distinct addr)
    into _merged_addresses
    from (
      select jsonb_array_elements_text(_existing_addresses) as addr
      union
      select jsonb_array_elements_text(_new_addresses) as addr
    ) combined;
    
    -- Update extra.addresses with merged array
    new.extra := jsonb_set(
      new.extra,
      '{addresses}',
      _merged_addresses
    );
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.before_insert_on_conversations()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  _existing_address uuid;
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
  where organization_address = new.organization_address
    and contact_address = new.contact_address
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
$function$
;

CREATE OR REPLACE FUNCTION public.change_contact_address(p_organization_id uuid, old_address text, new_address text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  _service public.service;
begin
  -- 1. Search for old contact address
  select service into _service
  from public.contacts_addresses
  where organization_id = p_organization_id
    and address = old_address;

  if _service is null then
    return; -- Exit if not found
  end if;

  -- 2. Create new contact address
  insert into public.contacts_addresses (organization_id, service, address, status)
  values (p_organization_id, _service, new_address, 'active')
  on conflict (organization_id, address) do nothing; -- Handle potential race conditions or re-delivery

  -- 3. Update old contact address status
  update public.contacts_addresses
  set status = 'inactive'
  where organization_id = p_organization_id
    and address = old_address;

  -- 4. Update contacts.extra.addresses: add new address (keep old for history)
  update public.contacts
  set extra = jsonb_set(
    extra,
    '{addresses}',
    (extra->'addresses') || to_jsonb(new_address)
  )
  where organization_id = p_organization_id
    and extra->'addresses' ? old_address
    and not extra->'addresses' ? new_address; -- avoid duplicates
end;
$function$
;

CREATE OR REPLACE FUNCTION public.before_insert_on_messages()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- If conversation_id is already provided, proceed as is
  if new.conversation_id is not null then
    return new;
  end if;

  -- Look up conversation_id from conversation table
  select id into new.conversation_id
  from public.conversations
  where organization_address = new.organization_address
    and contact_address = new.contact_address
    and group_address = new.group_address
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
$function$
;

CREATE TRIGGER lookup_and_merge_by_address BEFORE INSERT ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.before_insert_on_contacts();

CREATE TRIGGER handle_new_conversation BEFORE INSERT ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.before_insert_on_conversations();


