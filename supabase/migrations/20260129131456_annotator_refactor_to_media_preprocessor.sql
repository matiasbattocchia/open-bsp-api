drop trigger if exists "handle_message_to_annotator" on "public"."messages";

CREATE TRIGGER handle_message_to_media_preprocessor AFTER INSERT ON public.messages FOR EACH ROW WHEN ((((new.direction = 'outgoing'::public.direction) OR (new.direction = 'incoming'::public.direction)) AND ((new.status ->> 'pending'::text) IS NOT NULL) AND ((new.content ->> 'type'::text) = 'file'::text))) EXECUTE FUNCTION public.edge_function('/media-preprocessor', 'post');


-- Drop the old cron job first
select cron.unschedule('annotate-pending-messages');


select
  cron.schedule (
    'preprocess-pending-messages',
    '* * * * *',
    $$
    select
      net.http_post(
        url:=(select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_url') || '/media-preprocessor',
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
        status ->> 'preprocessing' is null
        or (status ->> 'preprocessing')::timestamptz < now() - interval '10 minutes'
      )
      and status ->> 'preprocessed' is null
    $$
  );