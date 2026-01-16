-- Drop the old cron job first
select cron.unschedule('annotate-pending-messages');

-- Recreate with updated column name (message -> content) and removed deprecated v0 check
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
      timestamp >= now() - interval '12 hours'
      and timestamp <= now() - interval '1 minutes'
      and content ->> 'type' = 'file'
      and status ->> 'pending' is not null
      and (
        status ->> 'annotating' is null
        or (status ->> 'annotating')::timestamptz < now() - interval '10 minutes'
      )
      and status ->> 'annotated' is null
    $$
  );
