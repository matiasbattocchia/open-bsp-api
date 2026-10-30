-- Stamps a dispatched message with the id the service gave it and merges in
-- the dispatch status, folding in any row a webhook created first for that
-- id: a status or an echo can arrive before the dispatcher has written the
-- id, and the webhook then upserts a status-only row of its own.
--
-- One transaction, so a webhook landing mid-merge cannot slip a new row in:
-- its upsert waits on the unique index for this transaction, then finds our
-- row holding the id and updates it.
--
-- Says whether it folded a webhook's row in.
--
-- Security invoker: members may neither update nor delete messages (05-05),
-- so only the service role gets anything done with it.
create function public.commit_dispatched_message(
  message_id uuid,
  status jsonb,
  external_id text default null -- absent when the send yields no id to track
) returns boolean
language plpgsql
security invoker
set search_path to ''
as $$
declare
  _duplicate_status jsonb;
begin
  if commit_dispatched_message.external_id is not null then
    delete from public.messages m
    where m.external_id = commit_dispatched_message.external_id
      and m.id <> commit_dispatched_message.message_id
    returning m.status into _duplicate_status;
  end if;

  -- The caller's keys win over the duplicate's; the set_status trigger then
  -- merges the result into our row's status.
  update public.messages m
  set
    external_id = coalesce(commit_dispatched_message.external_id, m.external_id),
    status = coalesce(_duplicate_status, '{}'::jsonb)
      || commit_dispatched_message.status
  where m.id = commit_dispatched_message.message_id;

  return _duplicate_status is not null;
end;
$$;
