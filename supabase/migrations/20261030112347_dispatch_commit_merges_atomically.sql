set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.commit_dispatched_message(message_id uuid, status jsonb, external_id text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$
;


