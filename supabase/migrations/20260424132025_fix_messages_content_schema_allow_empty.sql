alter table "public"."messages" drop constraint "messages_content_schema";

-- NOT VALID: skips validation of existing rows (legacy messages + status-only rows)
alter table "public"."messages" add constraint "messages_content_schema" CHECK (((content = '{}'::jsonb) OR (((content ->> 'version'::text) IS NOT NULL) AND ((content ->> 'type'::text) = ANY (ARRAY['text'::text, 'file'::text, 'data'::text])) AND ((content ->> 'kind'::text) IS NOT NULL)))) not valid;
