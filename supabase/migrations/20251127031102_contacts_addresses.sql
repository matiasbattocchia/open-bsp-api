alter table "public"."conversations" drop constraint "conversations_contact_id_fkey";

drop index if exists "public"."conversations_contact_id_idx";

drop index if exists "public"."unique_org_id_in_id";

drop index if exists "public"."unique_org_id_wa_id";


  create table "public"."contacts_addresses" (
    "organization_id" uuid not null,
    "contact_id" uuid not null,
    "service" public.service not null,
    "address" text not null,
    "extra" jsonb,
    "status" text not null default 'active'::text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."contacts_addresses" enable row level security;

alter table "public"."contacts" add column "status" text not null default 'active'::text;

alter table "public"."conversations" drop column "contact_id";

CREATE INDEX contacts_addresses_contact_id_idx ON public.contacts_addresses USING btree (contact_id);

CREATE INDEX contacts_addresses_organization_id_idx ON public.contacts_addresses USING btree (organization_id);

CREATE UNIQUE INDEX contacts_addresses_pkey ON public.contacts_addresses USING btree (address);

alter table "public"."contacts_addresses" add constraint "contacts_addresses_pkey" PRIMARY KEY using index "contacts_addresses_pkey";

alter table "public"."contacts_addresses" add constraint "contacts_addresses_contact_id_fkey" FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE not valid;

alter table "public"."contacts_addresses" validate constraint "contacts_addresses_contact_id_fkey";

alter table "public"."contacts_addresses" add constraint "contacts_addresses_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "public"."contacts_addresses" validate constraint "contacts_addresses_organization_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.change_contact_address(old_address text, new_address text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.mass_upsert_contacts(payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$
;

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
  if recent_conv is not null and recent_conv.name is null and new.name is not null then
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
    if recent_conv.organization_id is not null then
      new.organization_id = recent_conv.organization_id;
    else
    -- Look up organization_id if missing
      select organization_id into new.organization_id
      from public.organizations_addresses
      where address = new.organization_address;
    end if;
  end if;

  -- Reuse name from most recent conversation if missing
  if new.name is null then
    new.name := recent_conv.name;
  end if;

  return new;
end;
$function$
;

grant delete on table "public"."contacts_addresses" to "anon";

grant insert on table "public"."contacts_addresses" to "anon";

grant references on table "public"."contacts_addresses" to "anon";

grant select on table "public"."contacts_addresses" to "anon";

grant trigger on table "public"."contacts_addresses" to "anon";

grant truncate on table "public"."contacts_addresses" to "anon";

grant update on table "public"."contacts_addresses" to "anon";

grant delete on table "public"."contacts_addresses" to "authenticated";

grant insert on table "public"."contacts_addresses" to "authenticated";

grant references on table "public"."contacts_addresses" to "authenticated";

grant select on table "public"."contacts_addresses" to "authenticated";

grant trigger on table "public"."contacts_addresses" to "authenticated";

grant truncate on table "public"."contacts_addresses" to "authenticated";

grant update on table "public"."contacts_addresses" to "authenticated";

grant delete on table "public"."contacts_addresses" to "service_role";

grant insert on table "public"."contacts_addresses" to "service_role";

grant references on table "public"."contacts_addresses" to "service_role";

grant select on table "public"."contacts_addresses" to "service_role";

grant trigger on table "public"."contacts_addresses" to "service_role";

grant truncate on table "public"."contacts_addresses" to "service_role";

grant update on table "public"."contacts_addresses" to "service_role";


  create policy "org members can read their orgs contacts addresses"
  on "public"."contacts_addresses"
  as permissive
  for select
  to authenticated
using ((contact_id IN ( SELECT contacts.id
   FROM public.contacts
  WHERE (contacts.organization_id IN ( SELECT public.get_authorized_orgs() AS get_authorized_orgs)))));


CREATE TRIGGER set_extra BEFORE UPDATE ON public.contacts_addresses FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION public.merge_update('extra');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.contacts_addresses FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');



