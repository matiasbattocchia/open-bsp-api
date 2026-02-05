drop trigger if exists "lookup_and_merge_by_address" on "public"."contacts";

drop function if exists "public"."before_insert_on_contacts"();

drop index if exists "public"."contacts_extra_addresses_idx";

alter table "public"."contacts_addresses" add column "contact_id" uuid;

CREATE INDEX contacts_addresses_contact_id_idx ON public.contacts_addresses USING btree (contact_id);

alter table "public"."contacts_addresses" add constraint "contacts_addresses_contact_id_fkey" FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL not valid;

alter table "public"."contacts_addresses" validate constraint "contacts_addresses_contact_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.cleanup_addresses_before_contact_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Delete addresses linked to this contact that have NO conversations
  delete from public.contacts_addresses ca
  where ca.contact_id = old.id
    and not exists (
      select 1 from public.conversations c
      where c.organization_id = ca.organization_id
        and c.contact_address = ca.address
    )
    -- Do not delete synced addresses (externally managed)
    and not (ca.extra ? 'synced');
  
  -- Remaining addresses will have contact_id set to NULL (via ON DELETE SET NULL FK)
  -- because they have history (conversations) and must be preserved.
  
  return old;
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
      and extra = p_extra
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
  _contact_id_to_check uuid;
  _other_active_count int;
begin
  -- Case 1: Synced Action = ADD
  if new.extra->'synced'->>'action' = 'add' then
    -- Check if we can reuse existing contact from OLD (if updating)
    if (TG_OP = 'UPDATE') and old.contact_id is not null then
      new.contact_id := old.contact_id;
    end if;

    -- If still no contact linked, create one
    if new.contact_id is null then
      insert into public.contacts (
        organization_id,
        name
      ) values (
        new.organization_id,
        new.extra->'synced'->>'name'
      ) returning id into new.contact_id;
    end if;
    
    return new;
  end if;

  -- Case 2: Synced Action = REMOVE
  if new.extra->'synced'->>'action' = 'remove' then
    -- Identify the contact we might be orphaning (from OLD state)
    _contact_id_to_check := old.contact_id;

    -- If there was a contact linked, check if it becomes orphaned
    if _contact_id_to_check is not null then
       -- Count OTHER active addresses for this contact
       select count(*) into _other_active_count
       from public.contacts_addresses
       where contact_id = _contact_id_to_check
         and status = 'active'
         -- Exclude the current address being processed
         and not (organization_id = new.organization_id and address = new.address);
       
       -- If no other addresses reference it, delete the contact
       if _other_active_count = 0 then
         delete from public.contacts where id = _contact_id_to_check;
       end if;
    end if;

    -- Check if we should delete this address (no conversations)
    if not exists (
      select 1 from public.conversations c 
      where c.organization_id = new.organization_id 
        and c.contact_address = new.address
    ) then
      -- Delete self and cancel update
      delete from public.contacts_addresses
      where organization_id = new.organization_id
        and address = new.address;
      return null; 
    end if;

    -- Otherwise, just unlink
    new.contact_id := null;
    return new;
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
  _contact_id uuid;
  _service public.service;
begin
  -- 1. Search for old contact address and get service & contact_id
  select service, contact_id into _service, _contact_id
  from public.contacts_addresses
  where organization_id = p_organization_id
    and address = old_address;

  if _service is null then
    return; -- Exit if not found
  end if;

  -- 2. Create new contact address (linked to same contact if it exists)
  -- Add extra.replaces_address
  insert into public.contacts_addresses (
    organization_id, service, address, contact_id, status, extra
  )
  values (
    p_organization_id, 
    _service, 
    new_address, 
    _contact_id, 
    'active',
    jsonb_build_object('replaces_address', old_address)
  )
  on conflict (organization_id, address) do update set
    contact_id = EXCLUDED.contact_id,
    status = 'active',
    extra = jsonb_set(
      coalesce(public.contacts_addresses.extra, '{}'::jsonb),
      '{replaces_address}',
      to_jsonb(old_address)
    );

  -- 3. Update old contact address status and add reference to new address
  update public.contacts_addresses set 
    status = 'inactive',
    extra = jsonb_set(
      coalesce(extra, '{}'::jsonb),
      '{replaced_by_address}',
      to_jsonb(new_address)
    )
  where organization_id = p_organization_id
    and address = old_address;
end;
$function$
;


  create policy "members can delete non-synced contacts addresses"
  on "public"."contacts_addresses"
  as permissive
  for delete
  to authenticated, anon
using (((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)) AND (NOT (((extra -> 'synced'::text) ->> 'action'::text) = 'add'::text))));



  create policy "members can insert contacts addresses"
  on "public"."contacts_addresses"
  as permissive
  for insert
  to authenticated, anon
with check (((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)) AND (NOT (((extra -> 'synced'::text) ->> 'action'::text) = 'add'::text))));



  create policy "members can update contacts addresses"
  on "public"."contacts_addresses"
  as permissive
  for update
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)))
with check (((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)) AND public.contact_address_update_rules(organization_id, service, address, extra, status)));


CREATE TRIGGER cleanup_addresses_before_contact_delete BEFORE DELETE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.cleanup_addresses_before_contact_delete();

CREATE TRIGGER manage_contact_on_address_sync BEFORE INSERT OR UPDATE ON public.contacts_addresses FOR EACH ROW WHEN (((new.extra -> 'synced'::text) IS NOT NULL)) EXECUTE FUNCTION public.manage_contact_on_address_sync();


