create or replace function public.change_contact_address(
  p_organization_id uuid,
  old_address text,
  new_address text
)
returns void
language plpgsql
security invoker
set search_path to ''
as $$
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
$$;
