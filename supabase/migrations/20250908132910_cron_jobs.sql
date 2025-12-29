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
      and timestamp >= now() - interval '12 hours'
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
      timestamp >= now() - interval '12 hours'
      and timestamp <= now() - interval '1 minutes'
      and (
        message ->> 'media' is not null -- message v0 - TODO: deprecate
        or message ->> 'type' = 'file' -- message v1
      )
      and status ->> 'pending' is not null
      and (
        status ->> 'annotating' is null
        or (status ->> 'annotating')::timestamptz < now() - interval '10 minutes'
      )
      and status ->> 'annotated' is null
    $$
  );

-- Allow org members to upload and download media
-- Replaced at supabase/migrations/20251229144620_rls_rework.sql
create policy "org members can manage their orgs media"
on storage.objects
to authenticated
using (
  bucket_id = 'media' and
  (
    (storage.foldername(name))[1] in ( select get_authorized_orgs()::text ) -- message v0 - TODO: deprecate
    or (storage.foldername(name))[2] in ( select get_authorized_orgs()::text ) -- message v1 path is organizations/<org_id>/attachments/<file_id>
  )
);