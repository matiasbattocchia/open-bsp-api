drop trigger if exists "mark_outgoing_local_message_as_sent" on "public"."messages";

drop trigger if exists "handle_outgoing_message_to_dispatcher" on "public"."messages";

drop function if exists "public"."mark_outgoing_local_message_as_sent"();

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.dispatcher_edge_function()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  service text := new.service::text;
  path text := concat('/', service, '-dispatcher');
  request_id bigint;
  payload jsonb;
  base_url text;
  auth_token text;
  headers jsonb;
  timeout_ms integer := 10000;
begin
  if service = 'local' then
    update public.messages set status = jsonb_build_object('delivered', now()) where id = new.id;

    return new;
  end if;

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
    timeout_ms
  );

  insert into supabase_functions.hooks
    (hook_table_id, hook_name, request_id)
  values
    (tg_relid, tg_name, request_id);

  return new;
end;
$function$
;

CREATE TRIGGER handle_outgoing_message_to_dispatcher AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.direction = 'outgoing'::direction) AND (new."timestamp" <= now()) AND ((new.status ->> 'pending'::text) IS NOT NULL))) EXECUTE FUNCTION dispatcher_edge_function();


