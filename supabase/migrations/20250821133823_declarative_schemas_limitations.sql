-- https://supabase.com/docs/guides/migrations/declarative-schemas#limitations

-- Cron jobs
select
  cron.schedule (
    'dispatch-outgoing-pending-messages',
    '30 seconds',
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
      and service <> 'local'
      and timestamp >= now() - interval '10 minutes'
      and timestamp <= now() - interval '1 minutes'
      and status ->> 'held_for_quality_assessment' is null
      and status ->> 'accepted' is null
      and status ->> 'sent' is null
      and status ->> 'delivered' is null
      and status ->> 'read' is null
      and status ->> 'failed' is null
    $$
  );

-- Delete old cron.job_run_details records of the current user every day at noon
select
  cron.schedule (
    'delete-job-run-details',
    '0 12 * * *',
    $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$
  );

-- Storage
insert into storage.buckets (id, name, public) values ('media', 'media', false);

-- Realtime
alter publication "supabase_realtime" add table only "public"."conversations";
alter publication "supabase_realtime" add table only "public"."messages";
