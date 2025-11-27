create or replace function public.mass_upsert_contacts(payload jsonb)
returns void
language plpgsql
security invoker
set search_path to ''
as $$
declare
  item jsonb;
  _org_id uuid;
  _contact_id uuid;
  _address text;
  _service public.service;
  _name text;
  _status text;
  _org_address text;
begin
  for item in select * from jsonb_array_elements(payload)
  loop
    _org_address := item->>'organization_address';
    _address := item->>'contact_address';
    _service := (item->>'service')::public.service;
    _name := item->>'name';
    _status := item->>'status';

    -- Get organization_id
    select organization_id into _org_id
    from public.organizations_addresses
    where address = _org_address;

    -- Check if address exists
    select contact_id into _contact_id
    from public.contacts_addresses
    where address = _address;

    if _contact_id is null then
      -- 2.1 Does not exist -> Add
      if _status = 'active' then
        insert into public.contacts (organization_id, name, status)
        values (_org_id, coalesce(_name, '?'), 'active')
        returning id into _contact_id;

        insert into public.contacts_addresses (organization_id, contact_id, service, address, status)
        values (_org_id, _contact_id, _service, _address, 'active');
      end if;
    else
      -- 2.2 Exists -> Update/Remove
      if _status = 'active' then
         update public.contacts
         set name = coalesce(_name, name),
             status = 'active'
         where id = _contact_id;
      elsif _status = 'inactive' then
         update public.contacts
         set status = 'inactive'
         where id = _contact_id;
      end if;
    end if;
  end loop;
end;
$$;

create or replace function public.change_contact_address(old_address text, new_address text)
returns void
language plpgsql
security invoker
set search_path to ''
as $$
declare
  _org_id uuid;
  _contact_id uuid;
  _service public.service;
begin
  -- 1. Search for old contact address
  select organization_id, contact_id, service
  into _org_id, _contact_id, _service
  from public.contacts_addresses
  where address = old_address;

  if _org_id is null then
    return; -- Exit if not found
  end if;

  -- 2. Create new contact address
  insert into public.contacts_addresses (organization_id, contact_id, service, address, status)
  values (_org_id, _contact_id, _service, new_address, 'active')
  on conflict (address) do nothing; -- Handle potential race conditions or re-delivery

  -- 3. Update old contact address status
  update public.contacts_addresses
  set status = 'inactive'
  where address = old_address;
end;
$$;
