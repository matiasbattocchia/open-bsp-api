drop trigger if exists "handle_mark_as_read_to_dispatcher" on "public"."messages";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.create_message()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- If both organization_id and conversation_id already provided, proceed as is
  if new.organization_id is not null and new.conversation_id is not null then
    return new;
  end if;

  -- Look up both organization_id and conversation_id from conversation table
  select organization_id, id into new.organization_id, new.conversation_id
  from public.conversations
  where organization_address = new.organization_address
    and contact_address = new.contact_address
    and status = 'active'
  order by created_at desc
  limit 1;

  -- Create conversation if it doesn't exist (create_conversation trigger will handle organization_id lookup)
  if new.conversation_id is null then
    insert into public.conversations (
      organization_address,
      contact_address,
      service
    ) values (
      new.organization_address,
      new.contact_address,
      new.service
    )
    returning id, organization_id into new.conversation_id, new.organization_id;
  end if;

  return new;
end;
$function$
;

CREATE TRIGGER handle_mark_as_read_to_dispatcher AFTER UPDATE ON public.messages FOR EACH ROW WHEN (((new.direction = 'incoming'::public.direction) AND (new.service <> 'local'::public.service) AND (((old.status ->> 'read'::text) <> (new.status ->> 'read'::text)) OR ((old.status ->> 'typing'::text) <> (new.status ->> 'typing'::text))) AND ((new.status ->> 'pending'::text) IS NOT NULL))) EXECUTE FUNCTION public.dispatcher_edge_function();
