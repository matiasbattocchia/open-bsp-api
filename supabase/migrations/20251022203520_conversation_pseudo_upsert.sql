drop function if exists "public"."bulk_update_messages_status"(records jsonb);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.create_conversation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
  -- Note: status is defined as not null, if null, there is no conversation.
  if recent_conv is not null and new.name is not null and
  (recent_conv.name is null or (new.extra->'smb_contact')::boolean is true) then
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
    if recent_conv.organization_id then
      new.organization_id = recent_conv.organization_id;
    else
    -- Look up organization_id if missing
      select organization_id into new.organization_id
      from public.organizations_addresses
      where address = new.organization_address;
    end if;
  end if;

  -- Reuse contact_id from most recent conversation if missing
  if new.contact_id is null then
    new.contact_id := recent_conv.contact_id;
  end if;

  -- Reuse name from most recent conversation if missing
  if new.name is null then
    new.name := recent_conv.name;
  end if;

  return new;
end;
$function$
;
