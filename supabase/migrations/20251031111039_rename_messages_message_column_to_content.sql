drop trigger if exists "handle_message_to_annotator" on "public"."messages";

drop trigger if exists "set_message" on "public"."messages";

drop function if exists "public"."merge_update_message"();

alter table "public"."messages" rename column "message" to "content";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.merge_update_content()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.message := merge_update_jsonb(old.content, '{}', new.content);

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.merge_update_jsonb(target jsonb, path text[], object jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  i int;
  key text;
  value jsonb;
begin
  if target is null then
    target := '{}'::jsonb;
  end if;

  case jsonb_typeof(object) -- object, array, string, number, boolean, and null
    when null then
      target := null;
    when 'object' then
      if object = '{}'::jsonb then
        target := jsonb_set(target, path, object, true);
      else
        if jsonb_typeof(target #> path) <> 'object' or target #> path is null then
            target := jsonb_set(target, path, '{}', true);
        end if;

        for key, value in select * from jsonb_each(object) loop
            target := public.merge_update_jsonb(target, array_append(path, key), value);
        end loop;
      end if;
    -- when 'array' then
    --   if jsonb_typeof(target #> path) <> 'array' or target #> path is null then
    --     target := jsonb_set(target, path, '[]', true);
    --   end if;

    --   i := 0;
    --   for value in select * from jsonb_array_elements(object) loop
    --     target := public.merge_update_jsonb(target, array_append(path, i::text), value);
    --     i := i + 1;
    --   end loop;
    else
      target := jsonb_set(target, path, object, true);
  end case;

  return target;
end;
$function$
;

CREATE TRIGGER handle_message_to_annotator AFTER INSERT ON public.messages FOR EACH ROW WHEN ((((new.direction = 'outgoing'::public.direction) OR (new.direction = 'incoming'::public.direction)) AND ((new.status ->> 'pending'::text) IS NOT NULL) AND ((new.content ->> 'type'::text) = 'file'::text))) EXECUTE FUNCTION public.edge_function('/annotator', 'post');

CREATE TRIGGER set_message BEFORE UPDATE ON public.messages FOR EACH ROW WHEN ((new.content IS NOT NULL)) EXECUTE FUNCTION public.merge_update_content();
