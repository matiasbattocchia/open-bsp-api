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
