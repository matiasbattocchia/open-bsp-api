drop trigger if exists "cleanup_addresses_before_contact_delete" on "public"."contacts";

drop policy "members can delete non-synced contacts addresses" on "public"."contacts_addresses";

drop policy "members can insert contacts addresses" on "public"."contacts_addresses";

drop function if exists "public"."cleanup_addresses_before_contact_delete"();

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.cleanup_unlinked_address_if_empty()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- Only if we became unlinked (contact_id IS NULL)
  if new.contact_id is null and old.contact_id is not null then
    -- If no conversations, delete the address
    if not exists (
      select 1 from public.conversations c 
      where c.organization_id = new.organization_id 
        and c.contact_address = new.address
    ) then
      delete from public.contacts_addresses
      where organization_id = new.organization_id
        and address = new.address;
    end if;
  end if;

  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.contact_address_update_rules(p_organization_id uuid, p_service public.service, p_address text, p_extra jsonb, p_status text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  return exists (
    select 1 from public.contacts_addresses
    where organization_id = p_organization_id
      and address = p_address
      and service = p_service
      and status = p_status
      and extra is not distinct from p_extra
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.manage_contact_on_address_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  _other_active_count int;
begin
  -- Case 1: Synced Action = ADD
  if new.extra->'synced'->>'action' = 'add' then
    -- If no contact linked (neither from old row nor provided in new data), create one
    if (old is null or old.contact_id is null) and new.contact_id is null then
      insert into public.contacts (
        organization_id,
        name
      ) values (
        new.organization_id,
        new.extra->'synced'->>'name'
      ) returning id into new.contact_id;
    end if;
  end if;

  -- Case 2: Synced Action = REMOVE
  if new.extra->'synced'->>'action' = 'remove' then
    -- If there was a contact linked, check if it becomes orphaned
    if old.contact_id is not null then
       -- Count OTHER active addresses for this contact
       select count(*) into _other_active_count
       from public.contacts_addresses
       where contact_id = old.contact_id
         and status = 'active'
         -- Exclude the current address being processed
         and not (organization_id = new.organization_id and address = new.address);
       
       -- If no other addresses reference it, delete the contact
       if _other_active_count = 0 then
         delete from public.contacts where id = old.contact_id;
       end if;
    end if;

    -- Unlink
    -- Note: the address might be deleted by cleanup_unlinked_address_if_empty
    new.contact_id := null;
  end if;

  return new;
end;
$function$
;


  create policy "members can delete non-synced contacts addresses"
  on "public"."contacts_addresses"
  as permissive
  for delete
  to authenticated, anon
using (((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)) AND (((extra -> 'synced'::text) ->> 'action'::text) IS DISTINCT FROM 'add'::text)));



  create policy "members can insert contacts addresses"
  on "public"."contacts_addresses"
  as permissive
  for insert
  to authenticated, anon
with check (((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)) AND (((extra -> 'synced'::text) ->> 'action'::text) IS DISTINCT FROM 'add'::text)));


CREATE TRIGGER cleanup_unlinked_address_if_empty AFTER UPDATE ON public.contacts_addresses FOR EACH ROW WHEN (((old.contact_id IS NOT NULL) AND (new.contact_id IS NULL) AND (((new.extra -> 'synced'::text) ->> 'action'::text) IS DISTINCT FROM 'add'::text))) EXECUTE FUNCTION public.cleanup_unlinked_address_if_empty();


