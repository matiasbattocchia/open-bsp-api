-- 1. Add the 'whatsapp-web' service (self-hosted whatsmeow bridge channel).
--    Hand-written ADD VALUE instead of the generated rename/recreate/recast:
--    service columns are referenced by RLS policies, so the recast fails with
--    "cannot alter type of a column used in a policy definition".
alter type "public"."service" add value if not exists 'whatsapp-web';

-- 2. contacts_addresses PK gains service: the same canonical address (e.g.
--    bare phone digits shared by 'whatsapp' and 'whatsapp-web') is a separate
--    row per service. Cross-service identity lives at the contacts level via
--    contact_id. The conversations FK extends accordingly.
alter table "public"."conversations" drop constraint "conversations_contact_address_fkey";

alter table "public"."contacts_addresses" drop constraint "contacts_addresses_pkey";

drop index if exists "public"."contacts_addresses_pkey";

CREATE UNIQUE INDEX contacts_addresses_pkey ON public.contacts_addresses USING btree (organization_id, service, address);

alter table "public"."contacts_addresses" add constraint "contacts_addresses_pkey" PRIMARY KEY using index "contacts_addresses_pkey";

alter table "public"."conversations" add constraint "conversations_contact_address_fkey" FOREIGN KEY (organization_id, service, contact_address) REFERENCES public.contacts_addresses(organization_id, service, address) not valid;

alter table "public"."conversations" validate constraint "conversations_contact_address_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.before_insert_on_conversations()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  _existing_address text;
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
    and service = new.service
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
    and contact_address is not distinct from new.contact_address
    and group_address is not distinct from new.group_address
    and service = new.service
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
        and c.service = new.service
        and c.contact_address = new.address
    ) then
      delete from public.contacts_addresses
      where organization_id = new.organization_id
        and service = new.service
        and address = new.address;
    end if;
  end if;

  return null;
end;
$function$
;
