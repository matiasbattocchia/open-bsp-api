drop trigger if exists "set_extra" on "public"."contacts_addresses";

drop trigger if exists "set_updated_at" on "public"."contacts_addresses";

drop trigger if exists "handle_new_conversation" on "public"."conversations";

drop policy "members can read their orgs contacts addresses" on "public"."contacts_addresses";

revoke delete on table "public"."contacts_addresses" from "anon";

revoke insert on table "public"."contacts_addresses" from "anon";

revoke references on table "public"."contacts_addresses" from "anon";

revoke select on table "public"."contacts_addresses" from "anon";

revoke trigger on table "public"."contacts_addresses" from "anon";

revoke truncate on table "public"."contacts_addresses" from "anon";

revoke update on table "public"."contacts_addresses" from "anon";

revoke delete on table "public"."contacts_addresses" from "authenticated";

revoke insert on table "public"."contacts_addresses" from "authenticated";

revoke references on table "public"."contacts_addresses" from "authenticated";

revoke select on table "public"."contacts_addresses" from "authenticated";

revoke trigger on table "public"."contacts_addresses" from "authenticated";

revoke truncate on table "public"."contacts_addresses" from "authenticated";

revoke update on table "public"."contacts_addresses" from "authenticated";

revoke delete on table "public"."contacts_addresses" from "service_role";

revoke insert on table "public"."contacts_addresses" from "service_role";

revoke references on table "public"."contacts_addresses" from "service_role";

revoke select on table "public"."contacts_addresses" from "service_role";

revoke trigger on table "public"."contacts_addresses" from "service_role";

revoke truncate on table "public"."contacts_addresses" from "service_role";

revoke update on table "public"."contacts_addresses" from "service_role";

alter table "public"."contacts_addresses" drop constraint "contacts_addresses_contact_id_fkey";

alter table "public"."contacts_addresses" drop constraint "contacts_addresses_organization_id_fkey";

alter table "public"."logs" drop constraint "logs_organization_address_fkey";

alter table "public"."conversations" drop constraint "conversations_organization_address_fkey";

drop function if exists "public"."before_insert_on_conversations"();

drop function if exists "public"."mass_upsert_contacts"(payload jsonb);

alter table "public"."contacts_addresses" drop constraint "contacts_addresses_pkey";

alter table "public"."organizations_addresses" drop constraint "organizations_addresses_pkey";

drop index if exists "public"."contacts_addresses_contact_id_idx";

drop index if exists "public"."contacts_addresses_organization_id_idx";

drop index if exists "public"."contacts_addresses_pkey";

drop index if exists "public"."conversations_organization_address_contact_address_idx";

drop index if exists "public"."conversations_organization_id_created_at_idx";

drop index if exists "public"."messages_conversation_id_created_at_idx";

drop index if exists "public"."messages_conversation_id_timestamp_idx";

drop index if exists "public"."organizations_addresses_organization_id_idx";

drop index if exists "public"."organizations_addresses_pkey";

drop table "public"."contacts_addresses";

alter table "public"."conversations" add column "group_address" text;

alter table "public"."conversations" alter column "organization_address" set not null;

alter table "public"."messages" add column "group_address" text;

alter table "public"."messages" alter column "contact_address" drop not null;

CREATE INDEX contacts_extra_addresses_idx ON public.contacts USING gin (((extra -> 'addresses'::text)));

CREATE INDEX conversations_contact_address_idx ON public.conversations USING btree (contact_address);

CREATE INDEX conversations_group_address_idx ON public.conversations USING btree (group_address);

CREATE INDEX conversations_organization_address_idx ON public.conversations USING btree (organization_address);

CREATE INDEX conversations_organization_id_idx ON public.conversations USING btree (organization_id);

CREATE INDEX conversations_updated_at_idx ON public.conversations USING btree (updated_at);

CREATE INDEX messages_conversation_id_idx ON public.messages USING btree (conversation_id);

CREATE INDEX messages_timestamp_idx ON public.messages USING btree ("timestamp");

CREATE INDEX messages_updated_at_idx ON public.messages USING btree (updated_at);

CREATE UNIQUE INDEX organizations_addresses_pkey ON public.organizations_addresses USING btree (organization_id, address);

alter table "public"."organizations_addresses" add constraint "organizations_addresses_pkey" PRIMARY KEY using index "organizations_addresses_pkey";

alter table "public"."logs" add constraint "logs_organization_id_organization_address_fkey" FOREIGN KEY (organization_id, organization_address) REFERENCES public.organizations_addresses(organization_id, address) ON DELETE CASCADE not valid;

alter table "public"."logs" validate constraint "logs_organization_id_organization_address_fkey";

alter table "public"."conversations" add constraint "conversations_organization_address_fkey" FOREIGN KEY (organization_id, organization_address) REFERENCES public.organizations_addresses(organization_id, address) not valid;

alter table "public"."conversations" validate constraint "conversations_organization_address_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.before_insert_on_messages()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- If both organization_id and conversation_id already provided, proceed as is
  if new.organization_id is not null and new.conversation_id is not null then
    return new;
  end if;

  -- Look up both organization_id and conversation_id from conversation table
  select organization_id, id into new.organization_id, new.conversation_id
  from public.conversations
  where organization_address = new.organization_address
    and contact_address = new.contact_address
    and group_address = new.group_address
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
      (
        select organization_id
        from public.organizations_addresses
        where address = new.organization_address
          and status = 'active'
        order by created_at desc
        limit 1
      ),
      new.organization_address,
      new.contact_address,
      new.group_address,
      new.service
    )
    returning id, organization_id into new.conversation_id, new.organization_id;
  end if;

  return new;
end;
$function$
;


