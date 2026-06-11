-- Instagram long-lived tokens expire 60 days after issuance (refreshable after
-- 24h). This daily cron asks instagram-management to refresh any tokens that are
-- near expiry. Mirrors the dispatch cron in 20250908132910_cron_jobs.sql:
-- net.http_post to the edge function with the edge_functions_token (which the
-- function validates against the service-role key).
select
  cron.schedule(
    'refresh-instagram-tokens',
    '0 3 * * *', -- daily at 03:00 UTC
    $$
    select
      net.http_post(
        url:=(select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_url') || '/instagram-management/refresh-tokens',
        headers:=jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_token')
        ),
        body:='{}'::jsonb,
        timeout_milliseconds:=10000
      ) as request_id
    $$
  );
