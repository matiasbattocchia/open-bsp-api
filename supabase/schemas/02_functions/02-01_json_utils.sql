create function public.merge_update_jsonb(target jsonb, path text[], object jsonb) returns jsonb
language plpgsql
immutable
set search_path to ''
as $$
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
            target := merge_update_jsonb(target, array_append(path, key), value); 
        end loop;
      end if;
    -- when 'array' then
    --   if jsonb_typeof(target #> path) <> 'array' or target #> path is null then
    --     target := jsonb_set(target, path, '[]', true);
    --   end if;

    --   i := 0;
    --   for value in select * from jsonb_array_elements(object) loop
    --     target := merge_update_jsonb(target, array_append(path, i::text), value);
    --     i := i + 1;
    --   end loop;
    else
      target := jsonb_set(target, path, object, true);
  end case;
  
  return target;
end;
$$;

create function public.merge_update_extra() returns trigger
language plpgsql
as $$
begin
  new.extra := merge_update_jsonb(old.extra, '{}', new.extra);

  return new;
end;
$$;

create function public.merge_update_message() returns trigger
language plpgsql
as $$
begin
  new.message := merge_update_jsonb(old.message, '{}', new.message);

  return new;
end;
$$;

create function public.merge_update_status() returns trigger
language plpgsql
as $$
begin
  new.status := merge_update_jsonb(old.status, '{}', new.status);

  return new;
end;
$$; 