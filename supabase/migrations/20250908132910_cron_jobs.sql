-- Cron jobs
select
  cron.schedule (
    'dispatch-outgoing-pending-messages',
    '* * * * *',
    $$
    select
      net.http_post(
        url:=(select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_url') || '/' || service || '-dispatcher',
        headers:=jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_token')
        ),
        body:=jsonb_build_object(
          'old_record', null,
          'record', m.*,
          'type', 'INSERT',
          'table', 'messages',
          'schema', 'public'
        ),
        timeout_milliseconds:=10000
      ) as request_id
    from
      public.messages as m
    where
      direction = 'outgoing'
      and timestamp >= now() - interval '60 minutes'
      and timestamp <= now() - interval '1 minutes'
      and status ->> 'pending' is not null
      and status ->> 'held_for_quality_assessment' is null
      and status ->> 'accepted' is null
      and status ->> 'sent' is null
      and status ->> 'delivered' is null
      and status ->> 'read' is null
      and status ->> 'failed' is null
    $$
  );

select
  cron.schedule (
    'annotate-pending-messages',
    '* * * * *',
    $$
    select
      net.http_post(
        url:=(select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_url') || '/annotator',
        headers:=jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_token')
        ),
        body:=jsonb_build_object(
          'old_record', null,
          'record', m.*,
          'type', 'INSERT',
          'table', 'messages',
          'schema', 'public'
        ),
        timeout_milliseconds:=10000
      ) as request_id
    from
      public.messages as m
    where
      timestamp >= now() - interval '60 minutes'
      and timestamp <= now() - interval '1 minutes'
      and status ->> 'pending' is not null
      and (
        status ->> 'annotating' is null
        or (status ->> 'annotating')::timestamptz < now() - interval '5 minutes'
      )
      and status ->> 'annotated' is null
    $$
  );