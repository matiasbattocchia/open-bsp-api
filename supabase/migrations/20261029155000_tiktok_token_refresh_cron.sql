-- TikTok account access tokens expire 24 hours after issuance; the refresh
-- token lasts a year. The dispatcher refreshes inline when it needs a token,
-- but idle accounts would lapse, so this cron sweeps every 4 hours and asks
-- tiktok-management to refresh any token expiring within the next 8h — every
-- token is renewed with hours to spare. Mirrors
-- 20260727210006_slack_token_refresh_cron.sql.
select
  cron.schedule(
    'refresh-tiktok-tokens',
    '45 */4 * * *', -- every 4 hours at :45, offset from the Slack sweep
    $$
    select
      net.http_post(
        url:=(select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_url') || '/tiktok-management/refresh-tokens',
        headers:=jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_token')
        ),
        body:='{}'::jsonb,
        timeout_milliseconds:=10000
      ) as request_id
    $$
  );
