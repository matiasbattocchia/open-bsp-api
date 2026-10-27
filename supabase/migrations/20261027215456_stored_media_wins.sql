set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.keep_stored_media()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.content->>'kind' = 'media_placeholder'
    and old.content->'file'->>'uri' is not null then
    new.content := old.content;
  elsif new.content->>'type' = 'file' and old.content ? 'data' then
    new.content := new.content || '{"data": null}'::jsonb;
  end if;

  return new;
end;
$function$
;

CREATE TRIGGER keep_stored_media BEFORE UPDATE ON public.messages FOR EACH ROW WHEN ((((new.content ->> 'kind'::text) = 'media_placeholder'::text) OR ((new.content ->> 'type'::text) = 'file'::text))) EXECUTE FUNCTION public.keep_stored_media();



-- DML (hand-written): bring existing rows to the one shape for media without
-- bytes — a media_placeholder with the reason in status.errors — and give
-- back the files the reverse-order merge hid behind a placeholder. Guarded on
-- the v1 shape: messages_content_schema is NOT VALID but still checked on
-- UPDATE.
--
-- User triggers off: keep_stored_media and the merges must not reinterpret a
-- rewrite of the whole document, and every webhook subscriber would hear
-- about each of these rows changing.
alter table public.messages disable trigger user;

-- A stored file a later placeholder masked (history sync, asset first). The
-- kind is read back from the mime type, so a sticker returns as an image.
update public.messages
set content = (content - 'data') || jsonb_build_object(
  'type', 'file',
  'kind', case
    when content->'file'->>'mime_type' like 'image/%' then 'image'
    when content->'file'->>'mime_type' like 'audio/%' then 'audio'
    when content->'file'->>'mime_type' like 'video/%' then 'video'
    else 'document'
  end
)
where content->>'kind' = 'media_placeholder'
  and content->'file'->>'uri' like 'internal://%'
  and content->>'version' is not null;

-- A file part whose uri is still the service's own reference: the bytes were
-- never stored. Empty on whatsapp-web before the bridge wrote placeholders, a
-- Meta media id on the Cloud API, an expired CDN URL on Instagram (an
-- external URL is a real file reference only where no download failed).
update public.messages
set content = (content - 'file') || jsonb_build_object(
  'type', 'data',
  'kind', 'media_placeholder',
  'data', '{}'::jsonb,
  'file', (content->'file') - 'uri'
)
where (
    (content->>'type' = 'file' and content->'file'->>'uri' not like 'internal://%'
      and (content->'file'->>'uri' !~ '^https?://' or status ? 'error'))
    or (content->>'kind' = 'media_placeholder' and content->'file' ? 'uri')
  )
  and content->>'version' is not null;

-- A file that replaced a placeholder kept the placeholder's empty `data`.
update public.messages
set content = content - 'data'
where content->>'type' = 'file' and content ? 'data';

-- The Meta webhooks wrote a single `error`; every other writer, `errors`.
update public.messages
set status = (status - 'error') || jsonb_build_object(
  'errors', coalesce(status->'errors', '[]'::jsonb) || jsonb_build_array(status->'error')
)
where status ? 'error';

alter table public.messages enable trigger user;
