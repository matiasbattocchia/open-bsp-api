set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.cleanup_orphaned_contact_on_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  _active_count int;
begin
  -- At this point new.contact_id is null (set by manage_contact_on_address_sync).
  -- Count any other active addresses still referencing the old contact.
  select count(*) into _active_count
  from public.contacts_addresses
  where contact_id = old.contact_id
    and status = 'active';

  -- If no other addresses reference it, delete the orphaned contact.
  if _active_count = 0 then
    delete from public.contacts where id = old.contact_id;
  end if;

  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.manage_contact_on_address_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  -- Unlink. The orphan cleanup happens in the AFTER trigger below to avoid
  -- error 27000 ("tuple to be updated was already modified by an operation
  -- triggered by the current command") caused by the ON DELETE SET NULL
  -- cascade touching the current row.
  -- Note: the address itself might be deleted by cleanup_unlinked_address_if_empty.
  if new.extra->'synced'->>'action' = 'remove' then
    new.contact_id := null;
  end if;

  return new;
end;
$function$
;

CREATE TRIGGER cleanup_orphaned_contact_on_sync AFTER UPDATE ON public.contacts_addresses FOR EACH ROW WHEN (((old.contact_id IS NOT NULL) AND (new.contact_id IS NULL) AND (((new.extra -> 'synced'::text) ->> 'action'::text) = 'remove'::text))) EXECUTE FUNCTION public.cleanup_orphaned_contact_on_sync();


