drop trigger if exists "handle_incoming_message_to_agent" on "public"."messages";

drop trigger if exists "handle_mark_as_read_to_dispatcher" on "public"."messages";

drop trigger if exists "handle_outgoing_message_to_dispatcher" on "public"."messages";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.edge_function()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION public.get_authorized_orgs(role text)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return query select organization_id from public.agents where user_id = auth.uid()
  and role in (select jsonb_array_elements_text(extra->'roles'));
end;
$function$
;

CREATE TRIGGER handle_incoming_message_to_agent AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.direction = 'incoming'::direction) AND ((new.status ->> 'pending'::text) IS NOT NULL))) EXECUTE FUNCTION edge_function('/agent-client', 'post');

CREATE TRIGGER handle_mark_as_read_to_dispatcher AFTER UPDATE ON public.messages FOR EACH ROW WHEN (((new.direction = 'incoming'::direction) AND (new.service <> 'local'::service) AND (((old.status ->> 'read'::text) <> (new.status ->> 'read'::text)) OR ((old.status ->> 'typing'::text) <> (new.status ->> 'typing'::text))))) EXECUTE FUNCTION dispatcher_edge_function();

CREATE TRIGGER handle_outgoing_message_to_dispatcher AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.direction = 'outgoing'::direction) AND (new.service <> 'local'::service) AND (new."timestamp" <= now()) AND ((new.status ->> 'pending'::text) IS NOT NULL))) EXECUTE FUNCTION dispatcher_edge_function();


