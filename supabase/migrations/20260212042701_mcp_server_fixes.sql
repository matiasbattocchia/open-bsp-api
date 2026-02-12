drop policy "owners can read their orgs api keys" on "public"."api_keys";

alter table "public"."organizations_addresses" alter column "status" set default 'connected'::text;

CREATE INDEX organizations_addresses_phone_number_idx ON public.organizations_addresses USING btree (((extra ->> 'phone_number'::text))) WHERE (service = 'whatsapp'::public.service);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.notify_webhook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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


  create policy "owners can read their orgs api keys"
  on "public"."api_keys"
  as permissive
  for select
  to authenticated, anon
using (((key = ((current_setting('request.headers'::text, true))::json ->> 'api-key'::text)) OR (organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs))));



