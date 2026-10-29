-- Hand-written ADD VALUE instead of the generated rename/recreate/recast:
-- service columns are referenced by RLS policies, so the recast fails with
-- "cannot alter type of a column used in a policy definition".
alter type "public"."service" add value if not exists 'tiktok';
