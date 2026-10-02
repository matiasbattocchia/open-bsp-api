-- The retry sweep backs off exponentially: a pending row is re-dispatched when
-- it is 1, 2, 4, 8 and 16 minutes old, then every 30 minutes until the 12-hour
-- window closes — 29 attempts, not 720. The schedule is read off the row's own
-- age, so it holds no per-row state and serves every service's dispatcher
-- alike. In the 30 days to 2026-10-02 every retried message that went out did
-- so within 5 minutes, which the early attempts still cover; a provider outage
-- costs at most 30 minutes past its recovery, and each row's own timestamp
-- spreads the catch-up instead of releasing it at once.
--
-- Hand-written: pg_cron schedules are imperative, db diff cannot model them.
select cron.unschedule('dispatch-outgoing-pending-messages');

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
      cross join lateral (
        select floor(extract(epoch from now() - m.timestamp) / 60)::int as age_minutes
      ) as a
    where
      sender_address is null
      and content ->> 'internal' is null
      and timestamp >= now() - interval '12 hours'
      and (a.age_minutes in (1, 2, 4, 8, 16) or (a.age_minutes >= 30 and a.age_minutes % 30 = 0))
      and status ->> 'pending' is not null
      and status ->> 'held_for_quality_assessment' is null
      and status ->> 'accepted' is null
      and status ->> 'sent' is null
      and status ->> 'delivered' is null
      and status ->> 'read' is null
      and status ->> 'failed' is null
    $$
  );
