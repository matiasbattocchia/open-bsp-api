create extension if not exists "pg_cron" with schema "pg_catalog";

create extension if not exists "moddatetime" with schema "public";

create type "public"."direction" as enum ('incoming', 'outgoing', 'internal');

create type "public"."service" as enum ('whatsapp', 'instagram', 'local');

create type "public"."type" as enum ('incoming', 'outgoing', 'draft', 'notification', 'function_call', 'function_response', 'internal');

create type "public"."webhook_operation" as enum ('insert', 'update');

create type "public"."webhook_table" as enum ('messages', 'conversations');


  create table "public"."agents" (
    "organization_id" uuid not null,
    "user_id" uuid,
    "id" uuid not null default gen_random_uuid(),
    "name" text not null,
    "picture" text,
    "ai" boolean not null,
    "extra" jsonb,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."agents" enable row level security;


  create table "public"."api_keys" (
    "id" uuid not null default gen_random_uuid(),
    "organization_id" uuid not null,
    "key" text not null,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."api_keys" enable row level security;


  create table "public"."contacts" (
    "organization_id" uuid not null,
    "id" uuid not null default gen_random_uuid(),
    "name" text not null,
    "extra" jsonb,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."contacts" enable row level security;


  create table "public"."conversations" (
    "organization_id" uuid not null,
    "contact_id" uuid,
    "service" service not null,
    "organization_address" text not null,
    "contact_address" text not null,
    "name" text not null,
    "extra" jsonb,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."conversations" enable row level security;


  create table "public"."messages" (
    "id" text not null default gen_random_uuid(),
    "external_id" text,
    "service" service not null,
    "organization_address" text not null,
    "contact_address" text not null,
    "direction" direction not null,
    "type" type not null,
    "message" jsonb not null,
    "agent_id" text,
    "status" jsonb not null default jsonb_build_object('pending', now()),
    "timestamp" timestamp with time zone not null default now(),
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."messages" enable row level security;


  create table "public"."organizations" (
    "id" uuid not null default gen_random_uuid(),
    "name" text not null,
    "extra" jsonb,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."organizations" enable row level security;


  create table "public"."organizations_addresses" (
    "organization_id" uuid not null,
    "service" service not null,
    "address" text not null,
    "extra" jsonb,
    "status" text not null default 'active'::text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."organizations_addresses" enable row level security;


  create table "public"."webhooks" (
    "id" uuid not null default gen_random_uuid(),
    "organization_id" uuid not null,
    "table_name" webhook_table not null,
    "operations" webhook_operation[] not null,
    "url" character varying not null,
    "token" character varying,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."webhooks" enable row level security;

CREATE UNIQUE INDEX agents_organization_id_user_id_key ON public.agents USING btree (organization_id, user_id);

CREATE UNIQUE INDEX agents_pkey ON public.agents USING btree (id);

CREATE INDEX agents_user_id_idx ON public.agents USING btree (user_id);

CREATE UNIQUE INDEX api_keys_key_key ON public.api_keys USING btree (key);

CREATE INDEX api_keys_organization_idx ON public.api_keys USING btree (organization_id);

CREATE UNIQUE INDEX api_keys_pkey ON public.api_keys USING btree (id);

CREATE INDEX contacts_organization_id_idx ON public.contacts USING btree (organization_id);

CREATE UNIQUE INDEX contacts_pkey ON public.contacts USING btree (id);

CREATE INDEX conversations_contact_id_idx ON public.conversations USING btree (contact_id);

CREATE INDEX conversations_idx ON public.conversations USING btree (organization_id, created_at);

CREATE UNIQUE INDEX conversations_pkey ON public.conversations USING btree (organization_address, contact_address);

CREATE UNIQUE INDEX messages_external_id_key ON public.messages USING btree (external_id);

CREATE INDEX messages_idx ON public.messages USING btree (organization_address, "timestamp");

CREATE INDEX messages_organization_address_created_at_idx ON public.messages USING btree (organization_address, created_at);

CREATE UNIQUE INDEX messages_pkey ON public.messages USING btree (id);

CREATE INDEX organizations_addresses_organization_id_idx ON public.organizations_addresses USING btree (organization_id);

CREATE UNIQUE INDEX organizations_addresses_pkey ON public.organizations_addresses USING btree (address);

CREATE UNIQUE INDEX organizations_pkey ON public.organizations USING btree (id);

CREATE UNIQUE INDEX unique_org_id_in_id ON public.contacts USING btree (organization_id, ((extra ->> 'internal_id'::text)));

CREATE UNIQUE INDEX unique_org_id_wa_id ON public.contacts USING btree (organization_id, ((extra ->> 'whatsapp_id'::text)));

CREATE INDEX webhooks_organization_idx ON public.webhooks USING btree (organization_id);

CREATE UNIQUE INDEX webhooks_pkey ON public.webhooks USING btree (id);

alter table "public"."agents" add constraint "agents_pkey" PRIMARY KEY using index "agents_pkey";

alter table "public"."api_keys" add constraint "api_keys_pkey" PRIMARY KEY using index "api_keys_pkey";

alter table "public"."contacts" add constraint "contacts_pkey" PRIMARY KEY using index "contacts_pkey";

alter table "public"."conversations" add constraint "conversations_pkey" PRIMARY KEY using index "conversations_pkey";

alter table "public"."messages" add constraint "messages_pkey" PRIMARY KEY using index "messages_pkey";

alter table "public"."organizations" add constraint "organizations_pkey" PRIMARY KEY using index "organizations_pkey";

alter table "public"."organizations_addresses" add constraint "organizations_addresses_pkey" PRIMARY KEY using index "organizations_addresses_pkey";

alter table "public"."webhooks" add constraint "webhooks_pkey" PRIMARY KEY using index "webhooks_pkey";

alter table "public"."agents" add constraint "agents_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE not valid;

alter table "public"."agents" validate constraint "agents_organization_id_fkey";

alter table "public"."agents" add constraint "agents_organization_id_user_id_key" UNIQUE using index "agents_organization_id_user_id_key";

alter table "public"."agents" add constraint "agents_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."agents" validate constraint "agents_user_id_fkey";

alter table "public"."api_keys" add constraint "api_keys_key_key" UNIQUE using index "api_keys_key_key";

alter table "public"."api_keys" add constraint "api_keys_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE not valid;

alter table "public"."api_keys" validate constraint "api_keys_organization_id_fkey";

alter table "public"."contacts" add constraint "contacts_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE not valid;

alter table "public"."contacts" validate constraint "contacts_organization_id_fkey";

alter table "public"."conversations" add constraint "conversations_contact_id_fkey" FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE not valid;

alter table "public"."conversations" validate constraint "conversations_contact_id_fkey";

alter table "public"."conversations" add constraint "conversations_organization_address_fkey" FOREIGN KEY (organization_address) REFERENCES organizations_addresses(address) not valid;

alter table "public"."conversations" validate constraint "conversations_organization_address_fkey";

alter table "public"."conversations" add constraint "conversations_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE not valid;

alter table "public"."conversations" validate constraint "conversations_organization_id_fkey";

alter table "public"."messages" add constraint "messages_external_id_key" UNIQUE using index "messages_external_id_key";

alter table "public"."organizations_addresses" add constraint "organizations_addresses_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE not valid;

alter table "public"."organizations_addresses" validate constraint "organizations_addresses_organization_id_fkey";

alter table "public"."webhooks" add constraint "webhooks_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE not valid;

alter table "public"."webhooks" validate constraint "webhooks_organization_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.bulk_update_messages_status(records jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  update messages o
  set status = r.status
  from (
    select * from jsonb_populate_recordset(null::messages, records)
  ) r
  where o.external_id = r.external_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_conversation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  service_id text := new.service || '_id';
begin
  assert new.name is not null, 'provide a name for the new contact in the "name" column';

  execute format('
    select oa.organization_id, c.id as contact_id
    from public.organizations_addresses as oa
    left join public.contacts as c
    on oa.organization_id = c.organization_id
    and c.extra->>%L = %L
    where oa.address = %L', 
    service_id, new.contact_address, new.organization_address
  ) into new.organization_id, new.contact_id;

  if new.contact_id is null then
    execute 'insert into public.contacts (organization_id, name, extra)
    values ($1, $2, $3)
    on conflict (organization_id, (extra->>' || quote_literal(service_id) || ')) do nothing
    returning id' into new.contact_id using new.organization_id, new.name, jsonb_build_object(service_id, new.contact_address);
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_organization()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  org_id uuid := new.id;
  org_address text := org_id::text;
begin
  insert into public.organizations_addresses (organization_id, service, address)
    values (org_id, 'local', org_address);

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.dispatcher_edge_function()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  service text := new.service::text;
  path text := concat('/', service, '-dispatcher');
  request_id bigint;
  payload jsonb;
  base_url text;
  auth_token text;
  headers jsonb;
begin
  select decrypted_secret into base_url from vault.decrypted_secrets where name = 'edge_functions_url';
  select decrypted_secret into auth_token from vault.decrypted_secrets where name = 'edge_functions_token';
  
  headers = jsonb_build_object(
    'content-type', 'application/json',
    'authorization', 'Bearer ' || auth_token
  );
  
  payload = jsonb_build_object(
    'old_record', old,
    'record', new,
    'type', tg_op,
    'table', tg_table_name,
    'schema', tg_table_schema
  );

  select http_post into request_id from net.http_post(
    base_url || path,
    payload,
    '{}'::jsonb,
    headers,
    1000
  );

  insert into supabase_functions.hooks
    (hook_table_id, hook_name, request_id)
  values
    (tg_relid, tg_name, request_id);

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.edge_function()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  declare
    request_id bigint;
    payload jsonb;
    base_url text;
    auth_token text;
    path text := tg_argv[0]::text;
    method text := tg_argv[1]::text;
    headers jsonb default '{}'::jsonb;
    params jsonb default '{}'::jsonb;
    timeout_ms integer default 1000;
  begin
    if path is null or path = 'null' then
      raise exception 'path argument is missing';
    end if;

    if method is null or method = 'null' then
      raise exception 'method argument is missing';
    end if;

    if tg_argv[2] is null or tg_argv[2] = 'null' then
      select decrypted_secret into auth_token from vault.decrypted_secrets where name = 'edge_functions_token';

      headers = jsonb_build_object(
        'content-type', 'application/json',
        'authorization', 'Bearer ' || auth_token
      );
    else
      headers = tg_argv[2]::jsonb;
    end if;

    if tg_argv[3] is null or tg_argv[3] = 'null' then
      params = '{}'::jsonb;
    else
      params = tg_argv[3]::jsonb;
    end if;

    if tg_argv[4] is null or tg_argv[4] = 'null' then
      timeout_ms = 1000;
    else
      timeout_ms = tg_argv[4]::integer;
    end if;

    select decrypted_secret into base_url from vault.decrypted_secrets where name = 'edge_functions_url';

    case
      when method = 'get' then
        select http_get into request_id from net.http_get(
          base_url || path,
          params,
          headers,
          timeout_ms
        );
      when method = 'post' then
        payload = jsonb_build_object(
          'old_record', old,
          'record', new,
          'type', tg_op,
          'table', tg_table_name,
          'schema', tg_table_schema
        );

        select http_post into request_id from net.http_post(
          base_url || path,
          payload,
          params,
          headers,
          timeout_ms
        );
      else
        raise exception 'method argument % is invalid', method;
    end case;

    insert into supabase_functions.hooks
      (hook_table_id, hook_name, request_id)
    values
      (tg_relid, tg_name, request_id);

    return new;
  end
$function$
;

CREATE OR REPLACE FUNCTION public.get_authorized_org_by_api_key()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  api_key text := current_setting('request.headers', true)::json->>'x-app-api-key';
  org_id uuid;
begin
  select organization_id from public.api_keys where key = api_key into org_id;

  if org_id is not null then
    return org_id;
  end if;

  raise exception using
    errcode = '42501',
    message = 'no registered api key found in x-app-api-key header';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_authorized_orgs()
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  return query select organization_id from public.agents where user_id = auth.uid();
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_authorized_orgs(role text)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  return query select organization_id from public.agents where user_id = auth.uid() and role in (select jsonb_array_elements_text(extra->'roles'));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_outgoing_local_message_as_sent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.status := merge_update_jsonb(new.status, '{}', jsonb_build_object('delivered', now()));
  new.updated_at := now() + interval '10 second';

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.merge_update_extra()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.extra := merge_update_jsonb(old.extra, '{}', new.extra);

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.merge_update_jsonb(target jsonb, path text[], object jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  i int;
  key text;
  value jsonb;
begin
  if target is null then
    target := '{}'::jsonb;
  end if;
  
  case jsonb_typeof(object) -- object, array, string, number, boolean, and null
    when null then
      target := null;
    when 'object' then
      if object = '{}'::jsonb then
        target := jsonb_set(target, path, object, true);
      else
        if jsonb_typeof(target #> path) <> 'object' or target #> path is null then
            target := jsonb_set(target, path, '{}', true);
        end if;

        for key, value in select * from jsonb_each(object) loop
            target := merge_update_jsonb(target, array_append(path, key), value); 
        end loop;
      end if;
    -- when 'array' then
    --   if jsonb_typeof(target #> path) <> 'array' or target #> path is null then
    --     target := jsonb_set(target, path, '[]', true);
    --   end if;

    --   i := 0;
    --   for value in select * from jsonb_array_elements(object) loop
    --     target := merge_update_jsonb(target, array_append(path, i::text), value);
    --     i := i + 1;
    --   end loop;
    else
      target := jsonb_set(target, path, object, true);
  end case;
  
  return target;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.merge_update_message()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.message := merge_update_jsonb(old.message, '{}', new.message);

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.merge_update_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.status := merge_update_jsonb(old.status, '{}', new.status);

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
    join public.organizations_addresses oa on oa.organization_id = w.organization_id
    where oa.address = new.organization_address
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

grant delete on table "public"."agents" to "anon";

grant insert on table "public"."agents" to "anon";

grant references on table "public"."agents" to "anon";

grant select on table "public"."agents" to "anon";

grant trigger on table "public"."agents" to "anon";

grant truncate on table "public"."agents" to "anon";

grant update on table "public"."agents" to "anon";

grant delete on table "public"."agents" to "authenticated";

grant insert on table "public"."agents" to "authenticated";

grant references on table "public"."agents" to "authenticated";

grant select on table "public"."agents" to "authenticated";

grant trigger on table "public"."agents" to "authenticated";

grant truncate on table "public"."agents" to "authenticated";

grant update on table "public"."agents" to "authenticated";

grant delete on table "public"."agents" to "service_role";

grant insert on table "public"."agents" to "service_role";

grant references on table "public"."agents" to "service_role";

grant select on table "public"."agents" to "service_role";

grant trigger on table "public"."agents" to "service_role";

grant truncate on table "public"."agents" to "service_role";

grant update on table "public"."agents" to "service_role";

grant delete on table "public"."api_keys" to "anon";

grant insert on table "public"."api_keys" to "anon";

grant references on table "public"."api_keys" to "anon";

grant select on table "public"."api_keys" to "anon";

grant trigger on table "public"."api_keys" to "anon";

grant truncate on table "public"."api_keys" to "anon";

grant update on table "public"."api_keys" to "anon";

grant delete on table "public"."api_keys" to "authenticated";

grant insert on table "public"."api_keys" to "authenticated";

grant references on table "public"."api_keys" to "authenticated";

grant select on table "public"."api_keys" to "authenticated";

grant trigger on table "public"."api_keys" to "authenticated";

grant truncate on table "public"."api_keys" to "authenticated";

grant update on table "public"."api_keys" to "authenticated";

grant delete on table "public"."api_keys" to "service_role";

grant insert on table "public"."api_keys" to "service_role";

grant references on table "public"."api_keys" to "service_role";

grant select on table "public"."api_keys" to "service_role";

grant trigger on table "public"."api_keys" to "service_role";

grant truncate on table "public"."api_keys" to "service_role";

grant update on table "public"."api_keys" to "service_role";

grant delete on table "public"."contacts" to "anon";

grant insert on table "public"."contacts" to "anon";

grant references on table "public"."contacts" to "anon";

grant select on table "public"."contacts" to "anon";

grant trigger on table "public"."contacts" to "anon";

grant truncate on table "public"."contacts" to "anon";

grant update on table "public"."contacts" to "anon";

grant delete on table "public"."contacts" to "authenticated";

grant insert on table "public"."contacts" to "authenticated";

grant references on table "public"."contacts" to "authenticated";

grant select on table "public"."contacts" to "authenticated";

grant trigger on table "public"."contacts" to "authenticated";

grant truncate on table "public"."contacts" to "authenticated";

grant update on table "public"."contacts" to "authenticated";

grant delete on table "public"."contacts" to "service_role";

grant insert on table "public"."contacts" to "service_role";

grant references on table "public"."contacts" to "service_role";

grant select on table "public"."contacts" to "service_role";

grant trigger on table "public"."contacts" to "service_role";

grant truncate on table "public"."contacts" to "service_role";

grant update on table "public"."contacts" to "service_role";

grant delete on table "public"."conversations" to "anon";

grant insert on table "public"."conversations" to "anon";

grant references on table "public"."conversations" to "anon";

grant select on table "public"."conversations" to "anon";

grant trigger on table "public"."conversations" to "anon";

grant truncate on table "public"."conversations" to "anon";

grant update on table "public"."conversations" to "anon";

grant delete on table "public"."conversations" to "authenticated";

grant insert on table "public"."conversations" to "authenticated";

grant references on table "public"."conversations" to "authenticated";

grant select on table "public"."conversations" to "authenticated";

grant trigger on table "public"."conversations" to "authenticated";

grant truncate on table "public"."conversations" to "authenticated";

grant update on table "public"."conversations" to "authenticated";

grant delete on table "public"."conversations" to "service_role";

grant insert on table "public"."conversations" to "service_role";

grant references on table "public"."conversations" to "service_role";

grant select on table "public"."conversations" to "service_role";

grant trigger on table "public"."conversations" to "service_role";

grant truncate on table "public"."conversations" to "service_role";

grant update on table "public"."conversations" to "service_role";

grant delete on table "public"."messages" to "anon";

grant insert on table "public"."messages" to "anon";

grant references on table "public"."messages" to "anon";

grant select on table "public"."messages" to "anon";

grant trigger on table "public"."messages" to "anon";

grant truncate on table "public"."messages" to "anon";

grant update on table "public"."messages" to "anon";

grant delete on table "public"."messages" to "authenticated";

grant insert on table "public"."messages" to "authenticated";

grant references on table "public"."messages" to "authenticated";

grant select on table "public"."messages" to "authenticated";

grant trigger on table "public"."messages" to "authenticated";

grant truncate on table "public"."messages" to "authenticated";

grant update on table "public"."messages" to "authenticated";

grant delete on table "public"."messages" to "service_role";

grant insert on table "public"."messages" to "service_role";

grant references on table "public"."messages" to "service_role";

grant select on table "public"."messages" to "service_role";

grant trigger on table "public"."messages" to "service_role";

grant truncate on table "public"."messages" to "service_role";

grant update on table "public"."messages" to "service_role";

grant delete on table "public"."organizations" to "anon";

grant insert on table "public"."organizations" to "anon";

grant references on table "public"."organizations" to "anon";

grant select on table "public"."organizations" to "anon";

grant trigger on table "public"."organizations" to "anon";

grant truncate on table "public"."organizations" to "anon";

grant update on table "public"."organizations" to "anon";

grant delete on table "public"."organizations" to "authenticated";

grant insert on table "public"."organizations" to "authenticated";

grant references on table "public"."organizations" to "authenticated";

grant select on table "public"."organizations" to "authenticated";

grant trigger on table "public"."organizations" to "authenticated";

grant truncate on table "public"."organizations" to "authenticated";

grant update on table "public"."organizations" to "authenticated";

grant delete on table "public"."organizations" to "service_role";

grant insert on table "public"."organizations" to "service_role";

grant references on table "public"."organizations" to "service_role";

grant select on table "public"."organizations" to "service_role";

grant trigger on table "public"."organizations" to "service_role";

grant truncate on table "public"."organizations" to "service_role";

grant update on table "public"."organizations" to "service_role";

grant delete on table "public"."organizations_addresses" to "anon";

grant insert on table "public"."organizations_addresses" to "anon";

grant references on table "public"."organizations_addresses" to "anon";

grant select on table "public"."organizations_addresses" to "anon";

grant trigger on table "public"."organizations_addresses" to "anon";

grant truncate on table "public"."organizations_addresses" to "anon";

grant update on table "public"."organizations_addresses" to "anon";

grant delete on table "public"."organizations_addresses" to "authenticated";

grant insert on table "public"."organizations_addresses" to "authenticated";

grant references on table "public"."organizations_addresses" to "authenticated";

grant select on table "public"."organizations_addresses" to "authenticated";

grant trigger on table "public"."organizations_addresses" to "authenticated";

grant truncate on table "public"."organizations_addresses" to "authenticated";

grant update on table "public"."organizations_addresses" to "authenticated";

grant delete on table "public"."organizations_addresses" to "service_role";

grant insert on table "public"."organizations_addresses" to "service_role";

grant references on table "public"."organizations_addresses" to "service_role";

grant select on table "public"."organizations_addresses" to "service_role";

grant trigger on table "public"."organizations_addresses" to "service_role";

grant truncate on table "public"."organizations_addresses" to "service_role";

grant update on table "public"."organizations_addresses" to "service_role";

grant delete on table "public"."webhooks" to "anon";

grant insert on table "public"."webhooks" to "anon";

grant references on table "public"."webhooks" to "anon";

grant select on table "public"."webhooks" to "anon";

grant trigger on table "public"."webhooks" to "anon";

grant truncate on table "public"."webhooks" to "anon";

grant update on table "public"."webhooks" to "anon";

grant delete on table "public"."webhooks" to "authenticated";

grant insert on table "public"."webhooks" to "authenticated";

grant references on table "public"."webhooks" to "authenticated";

grant select on table "public"."webhooks" to "authenticated";

grant trigger on table "public"."webhooks" to "authenticated";

grant truncate on table "public"."webhooks" to "authenticated";

grant update on table "public"."webhooks" to "authenticated";

grant delete on table "public"."webhooks" to "service_role";

grant insert on table "public"."webhooks" to "service_role";

grant references on table "public"."webhooks" to "service_role";

grant select on table "public"."webhooks" to "service_role";

grant trigger on table "public"."webhooks" to "service_role";

grant truncate on table "public"."webhooks" to "service_role";

grant update on table "public"."webhooks" to "service_role";


  create policy "org admins can create agents in their orgs"
  on "public"."agents"
  as permissive
  for insert
  to authenticated
with check ((organization_id IN ( SELECT get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "org admins can delete their org agents"
  on "public"."agents"
  as permissive
  for delete
  to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "org admins can update their org agents"
  on "public"."agents"
  as permissive
  for update
  to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs('admin'::text) AS get_authorized_orgs)))
with check ((organization_id IN ( SELECT get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "org members can read their org agents"
  on "public"."agents"
  as permissive
  for select
  to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));



  create policy "users can update their extra field except roles"
  on "public"."agents"
  as permissive
  for update
  to authenticated
using (((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)) AND (user_id = auth.uid())))
with check (((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)) AND (user_id = auth.uid()) AND ((extra -> 'roles'::text) IS NULL)));



  create policy "org admins can create api keys in their orgs"
  on "public"."api_keys"
  as permissive
  for insert
  to authenticated
with check ((organization_id IN ( SELECT get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "org admins can delete their org api keys"
  on "public"."api_keys"
  as permissive
  for delete
  to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "org members can read their org api keys"
  on "public"."api_keys"
  as permissive
  for select
  to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));



  create policy "org members can create their orgs contacts"
  on "public"."contacts"
  as permissive
  for insert
  to authenticated
with check ((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));



  create policy "org members can read their orgs contacts"
  on "public"."contacts"
  as permissive
  for select
  to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));



  create policy "org members can update their orgs contacts"
  on "public"."contacts"
  as permissive
  for update
  to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));



  create policy "anonymous can manage conversations with valid api key"
  on "public"."conversations"
  as permissive
  for all
  to anon
using ((organization_id = ( SELECT get_authorized_org_by_api_key() AS get_authorized_org_by_api_key)));



  create policy "org members can manage their orgs conversations"
  on "public"."conversations"
  as permissive
  for all
  to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));



  create policy "anonymous can manage messages with valid api key"
  on "public"."messages"
  as permissive
  for all
  to anon
using ((organization_address IN ( SELECT organizations_addresses.address
   FROM organizations_addresses
  WHERE (organizations_addresses.organization_id = ( SELECT get_authorized_org_by_api_key() AS get_authorized_org_by_api_key)))));



  create policy "org members can manage their orgs messages"
  on "public"."messages"
  as permissive
  for all
  to authenticated
using ((organization_address IN ( SELECT organizations_addresses.address
   FROM organizations_addresses
  WHERE (organizations_addresses.organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)))));



  create policy "org members can read their orgs"
  on "public"."organizations"
  as permissive
  for select
  to authenticated
using ((id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));



  create policy "org members can update their orgs"
  on "public"."organizations"
  as permissive
  for update
  to authenticated
using ((id IN ( SELECT get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "org members can read their orgs addresses"
  on "public"."organizations_addresses"
  as permissive
  for select
  to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));



  create policy "org admins can create webhooks in their orgs"
  on "public"."webhooks"
  as permissive
  for insert
  to authenticated
with check ((organization_id IN ( SELECT get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "org admins can delete their org webhooks"
  on "public"."webhooks"
  as permissive
  for delete
  to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "org admins can update their org webhooks"
  on "public"."webhooks"
  as permissive
  for update
  to authenticated
with check ((organization_id IN ( SELECT get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "org members can read their org webhooks"
  on "public"."webhooks"
  as permissive
  for select
  to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));


CREATE TRIGGER set_extra BEFORE UPDATE ON public.agents FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION merge_update_extra();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.api_keys FOR EACH ROW EXECUTE FUNCTION moddatetime('updated_at');

CREATE TRIGGER set_extra BEFORE UPDATE ON public.contacts FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION merge_update_extra();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION moddatetime('updated_at');

CREATE TRIGGER handle_new_conversation BEFORE INSERT ON public.conversations FOR EACH ROW WHEN ((new.organization_id IS NULL)) EXECUTE FUNCTION create_conversation();

CREATE TRIGGER notify_webhook_conversations AFTER INSERT OR UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION notify_webhook();

CREATE TRIGGER set_extra BEFORE UPDATE ON public.conversations FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION merge_update_extra();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION moddatetime('updated_at');

CREATE TRIGGER handle_incoming_message_to_agent AFTER INSERT ON public.messages FOR EACH ROW WHEN ((new.direction = 'incoming'::direction)) EXECUTE FUNCTION edge_function('/agent-client', 'post');

CREATE TRIGGER handle_mark_as_read_to_dispatcher AFTER UPDATE ON public.messages FOR EACH ROW WHEN (((new.direction = 'incoming'::direction) AND (new.service <> 'local'::service) AND ((((old.status ->> 'read'::text) IS NULL) AND ((new.status ->> 'read'::text) IS NOT NULL)) OR ((old.status ->> 'typing'::text) <> (new.status ->> 'typing'::text))))) EXECUTE FUNCTION dispatcher_edge_function();

CREATE TRIGGER handle_outgoing_message_to_dispatcher AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.direction = 'outgoing'::direction) AND (new.service <> 'local'::service) AND (new."timestamp" <= now()))) EXECUTE FUNCTION dispatcher_edge_function();

CREATE TRIGGER mark_outgoing_local_message_as_sent BEFORE INSERT ON public.messages FOR EACH ROW WHEN (((new.direction = 'outgoing'::direction) AND (new.service = 'local'::service) AND (new."timestamp" <= now()))) EXECUTE FUNCTION mark_outgoing_local_message_as_sent();

CREATE TRIGGER notify_webhook_messages AFTER INSERT OR UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION notify_webhook();

CREATE TRIGGER set_message BEFORE UPDATE ON public.messages FOR EACH ROW WHEN ((new.message IS NOT NULL)) EXECUTE FUNCTION merge_update_message();

CREATE TRIGGER set_status BEFORE UPDATE ON public.messages FOR EACH ROW WHEN ((new.status IS NOT NULL)) EXECUTE FUNCTION merge_update_status();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION moddatetime('updated_at');

CREATE TRIGGER handle_new_organization AFTER INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION create_organization();

CREATE TRIGGER set_extra BEFORE UPDATE ON public.organizations FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION merge_update_extra();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION moddatetime('updated_at');

CREATE TRIGGER set_extra BEFORE UPDATE ON public.organizations_addresses FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION merge_update_extra();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.organizations_addresses FOR EACH ROW EXECUTE FUNCTION moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.webhooks FOR EACH ROW EXECUTE FUNCTION moddatetime('updated_at');


