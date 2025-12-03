set check_function_bodies = off;

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
        if cardinality(path) = 0 then
          target := object;
        else
          target := jsonb_set(target, path, object, true);
        end if;
      else
        if jsonb_typeof(target #> path) <> 'object' or target #> path is null then
            if cardinality(path) = 0 then
              target := '{}'::jsonb;
            else
              target := jsonb_set(target, path, '{}', true);
            end if;
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



