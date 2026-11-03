-- A thread is a reply chain inside its conversation: a Slack thread reply
-- names its root in content.re_message_id. Rows filed by thread_id (the root's
-- bare ts) get that reference before the column goes; a root, whose thread_id
-- is its own ts, gets none.
update public.messages
set content = content || jsonb_build_object(
  're_message_id',
  organization_address || ':' || conversation_address || ':' || thread_id
)
where service = 'slack'
  and thread_id is not null
  and thread_id <> split_part(external_id, ':', 3)
  and content ->> 're_message_id' is null;

alter table "public"."messages" drop column "thread_id";
