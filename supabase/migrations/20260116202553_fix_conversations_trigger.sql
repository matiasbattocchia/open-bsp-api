set check_function_bodies = off;

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
$function$
;


