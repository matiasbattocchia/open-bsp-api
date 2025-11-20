alter table "public"."messages" alter column "agent_id" set data type uuid using "agent_id"::uuid;

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.pause_conversation_on_human_message()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  agent_is_ai boolean;
begin
  -- Check if message is from a human (null agent_id or agent with ai = false)
  if new.agent_id is not null then
    select ai into agent_is_ai
    from public.agents
    where id::text = new.agent_id;

    -- If agent exists and is AI, don't pause
    if agent_is_ai = true then
      return new;
    end if;
  end if;

  update public.conversations
  set extra = jsonb_build_object('paused', now())
  where id = new.conversation_id;

  return new;
end;
$function$
;

CREATE TRIGGER pause_conversation_on_human_message AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.direction = 'outgoing'::public.direction) AND (new.service <> 'local'::public.service) AND (new."timestamp" <= now()) AND (new."timestamp" >= (now() - '00:00:10'::interval)))) EXECUTE FUNCTION public.pause_conversation_on_human_message();
