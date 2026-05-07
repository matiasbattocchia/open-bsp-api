-- ============================================================================
-- Webhooks per organization_address (optional filter)
--
-- When organization_address is NULL, the webhook fires for all addresses
-- in the organization (current behavior). When set, it only fires for
-- messages/conversations from that specific address (phone number).
-- ============================================================================

-- 1. Add optional organization_address column
alter table public.webhooks
  add column if not exists organization_address text;

-- 2. Replace the notify_webhook function to support address filtering
create or replace function public.notify_webhook() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  webhook_record record;
  headers jsonb;
  record_address text;
begin
  -- Get the organization_address from the record (both messages and conversations have it)
  record_address := new.organization_address;

  -- Loop through all matching webhooks
  -- Match when: webhook has no address filter (NULL) OR address matches
  for webhook_record in
    select w.url, w.token
    from public.webhooks w
    where new.organization_id = w.organization_id
      and w.table_name = tg_table_name::public.webhook_table
      and lower(tg_op)::public.webhook_operation = any(w.operations)
      and (w.organization_address is null or w.organization_address = record_address)
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
$$;
