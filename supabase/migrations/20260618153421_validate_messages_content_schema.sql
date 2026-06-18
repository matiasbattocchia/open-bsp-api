-- messages_content_schema was re-added as NOT VALID by
-- 20260424132025_fix_messages_content_schema_allow_empty and never validated,
-- so it diverged from the schema file (an inline table constraint is always
-- VALID), making every `supabase db diff` re-emit a drop/re-add. Validate it to
-- converge. Safe: the prior (stricter) constraint was validated, so all
-- existing rows already satisfy this looser one.
alter table public.messages validate constraint messages_content_schema;
