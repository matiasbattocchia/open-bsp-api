-- NOT VALID: enforces for new rows only, skips validation of existing rows
-- (legacy version 0 messages don't have version/kind fields)
alter table "public"."messages" add constraint "messages_content_schema" CHECK ((((content ->> 'version'::text) IS NOT NULL) AND ((content ->> 'type'::text) = ANY (ARRAY['text'::text, 'file'::text, 'data'::text])) AND ((content ->> 'kind'::text) IS NOT NULL))) not valid;
