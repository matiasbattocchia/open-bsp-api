drop trigger if exists "handle_new_conversation" on "public"."conversations";

drop policy "anonymous can create messages with valid api key" on "public"."messages";

drop policy "anonymous can read messages with valid api key" on "public"."messages";

drop policy "org members can create their orgs messages" on "public"."messages";

drop policy "org members can read their orgs messages" on "public"."messages";

alter table "public"."conversations" drop constraint "conversations_pkey";

drop index if exists "public"."conversations_idx";

drop index if exists "public"."messages_idx";

drop index if exists "public"."messages_organization_address_created_at_idx";

drop index if exists "public"."conversations_pkey";

alter table "public"."conversations" add column "id" uuid not null default gen_random_uuid();

alter table "public"."conversations" add column "status" text not null default 'active'::text;

alter table "public"."conversations" alter column "name" drop not null;

alter table "public"."messages" alter column "id" set data type uuid using "id"::uuid;

-- Add column as nullable first
alter table "public"."messages" add column "conversation_id" uuid;

alter table "public"."messages" add column "organization_id" uuid;

-- Populate organization_id and conversation_id for existing messages
update public.messages m
set
  organization_id = c.organization_id,
  conversation_id = c.id
from public.conversations c
where m.organization_address = c.organization_address
  and m.contact_address = c.contact_address
;

-- Make columns not null after data migration
alter table "public"."messages" alter column "conversation_id" set not null;

alter table "public"."messages" alter column "organization_id" set not null;

CREATE INDEX conversations_organization_address_contact_address_idx ON public.conversations USING btree (organization_address, contact_address);

CREATE INDEX conversations_organization_id_created_at_idx ON public.conversations USING btree (organization_id, created_at);

CREATE INDEX messages_conversation_id_created_at_idx ON public.messages USING btree (conversation_id, created_at);

CREATE INDEX messages_conversation_id_timestamp_idx ON public.messages USING btree (conversation_id, "timestamp");

CREATE INDEX messages_organization_id_idx ON public.messages USING btree (organization_id);

CREATE UNIQUE INDEX conversations_pkey ON public.conversations USING btree (id);

alter table "public"."conversations" add constraint "conversations_pkey" PRIMARY KEY using index "conversations_pkey";

alter table "public"."messages" add constraint "messages_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE not valid;

alter table "public"."messages" validate constraint "messages_conversation_id_fkey";

alter table "public"."messages" add constraint "messages_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE not valid;

alter table "public"."messages" validate constraint "messages_organization_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.create_message()
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
    and status = 'active'
  order by created_at desc
  limit 1;

  -- Raise error if conversation does not exist
  if new.conversation_id is null then
    raise exception 'Active conversation not found for organization_address % and contact_address %',
      new.organization_address, new.contact_address;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_conversation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  existing_status text;
  existing_contact_id uuid;
begin
  -- Check most recent conversation for same organization and contact addresses
  select status, contact_id into existing_status, existing_contact_id
  from public.conversations
  where organization_address = new.organization_address
    and contact_address = new.contact_address
  order by created_at desc
  limit 1;

  -- If an active conversation exists, skip insertion
  if existing_status = 'active' then
    return null;
  end if;

  -- Look up organization_id if missing
  if new.organization_id is null then
    select organization_id into new.organization_id
    from public.organizations_addresses
    where address = new.organization_address;
  end if;

  -- Reuse contact_id from most recent conversation if missing
  if new.contact_id is null then
    new.contact_id := existing_contact_id;
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_webhook()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  webhook_record record;
  headers jsonb;
begin
  -- loop through all matching webhooks
  for webhook_record in
    select w.url, w.token
    from public.webhooks w
    where new.organization_id = w.organization_id
      and w.table_name = tg_table_name::public.webhook_table
      and lower(tg_op)::public.webhook_operation = any(w.operations)
    limit 3
  loop
    -- prepare headers
    headers := case
      when webhook_record.token is not null then
        jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || webhook_record.token
        )
      else
        jsonb_build_object(
          'content-type', 'application/json'
        )
      end;

    -- send webhook notification
    perform net.http_post(
      url := webhook_record.url,
      body := jsonb_build_object(
        'data', to_jsonb(new),
        'entity', tg_table_name,
        'action', lower(tg_op)
      ),
      headers := headers
    );
  end loop;

  return new;
end;
$function$
;

create policy "anonymous can create messages with valid api key"
on "public"."messages"
as permissive
for insert
to anon
with check ((organization_id IN ( SELECT get_authorized_org_by_api_key() AS get_authorized_org_by_api_key)));


create policy "anonymous can read messages with valid api key"
on "public"."messages"
as permissive
for select
to anon
using ((organization_id IN ( SELECT get_authorized_org_by_api_key() AS get_authorized_org_by_api_key)));


create policy "org members can create their orgs messages"
on "public"."messages"
as permissive
for insert
to authenticated
with check ((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));


create policy "org members can read their orgs messages"
on "public"."messages"
as permissive
for select
to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));


CREATE TRIGGER handle_new_message BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION create_message();

CREATE TRIGGER handle_new_conversation BEFORE INSERT ON public.conversations FOR EACH ROW EXECUTE FUNCTION create_conversation();
