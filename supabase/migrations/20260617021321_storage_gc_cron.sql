-- Organizations are deleted immediately, but their media files in the `media`
-- bucket are orphaned (storage.objects has no FK to organizations; the org id
-- only lives in the path organizations/<org_id>/attachments/<file_id>). This
-- hourly cron asks the storage-gc edge function to remove files whose org no
-- longer exists. Mirrors the dispatch / instagram-token crons: net.http_post to
-- the edge function with the edge_functions_token (validated by the function
-- against the service-role key).
select
  cron.schedule(
    'storage-gc-hourly',
    '0 * * * *', -- hourly, on the hour
    $$
    select
      net.http_post(
        url:=(select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_url') || '/storage-gc',
        headers:=jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_token')
        ),
        body:='{}'::jsonb,
        timeout_milliseconds:=10000
      ) as request_id
    $$
  );
