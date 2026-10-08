set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.init_data(p_organization_id uuid, p_limit integer DEFAULT 200, p_per_conversation integer DEFAULT 10, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  _messages json;
  _conversations json;
  _conversation_ids uuid[];
begin
  -- Up to p_per_conversation messages per conversation, p_limit in total,
  -- newest first.
  --
  -- Driven from conversations, never by ranking the org's messages: every
  -- returned message belongs to one of the p_limit conversations with the
  -- newest message (each of those contributes its own newest, which outranks
  -- anything from a conversation further down). So it costs one index probe
  -- per conversation plus p_limit short ones on messages_org_conv_timestamp_idx.
  -- A window over the org's messages reads every row it has, and at 64k
  -- messages that runs past the statement timeout.
  with latest as (
    select c.id, lm.timestamp
    from public.conversations c
    cross join lateral (
      select m.timestamp
      from public.messages m
      where m.organization_id = c.organization_id
        and m.conversation_id = c.id
        and (p_since is null or m.timestamp > p_since)
        and (p_until is null or m.timestamp < p_until)
      order by m.timestamp desc
      limit 1
    ) lm
    where c.organization_id = p_organization_id
    order by lm.timestamp desc
    limit p_limit
  ),
  limited as (
    select m.*
    from latest l
    cross join lateral (
      select m.*
      from public.messages m
      where m.organization_id = p_organization_id
        and m.conversation_id = l.id
        and (p_since is null or m.timestamp > p_since)
        and (p_until is null or m.timestamp < p_until)
      order by m.timestamp desc
      limit p_per_conversation
    ) m
    order by m.timestamp desc
    limit p_limit
  )
  select
    coalesce(json_agg(row_to_json(l.*)), '[]'::json),
    array_agg(distinct l.conversation_id)
  into _messages, _conversation_ids
  from limited l;

  -- Fetch conversations for the messages returned
  select coalesce(json_agg(row_to_json(c.*)), '[]'::json)
  into _conversations
  from public.conversations c
  where c.id = any(_conversation_ids);

  return json_build_object(
    'conversations', _conversations,
    'messages', _messages
  );
end;
$function$
;


