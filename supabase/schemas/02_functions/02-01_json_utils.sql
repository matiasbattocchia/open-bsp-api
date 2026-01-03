-- Behavior Summary:
-- | Value Type             | Behavior                               | Merges? |
-- |------------------------|----------------------------------------|---------|
-- | null                   | Replaces entire target with null       | NO      |
-- | {} (empty object)      | Recursively merges (no-op if empty)    | YES     |
-- | Non-empty object       | Recursively merges nested keys         | YES     |
-- | String/Number/Boolean  | Replaces value at path                 | NO      |
--
-- Note: Arrays are currently REPLACED, not merged (array merge logic is commented out).
-- Example: {"tags": ["a", "b"]} + update tags to ["c"] = {"tags": ["c"]}

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
$$;

create function public.merge_update() returns trigger
language plpgsql
as $$
declare
  column_name text := tg_argv[0]::text;
  old_jsonb jsonb;
  new_jsonb jsonb;
  merged_value jsonb;
begin
  -- Get the column name from trigger argument
  if column_name is null or column_name = 'null' then
    raise exception 'column_name argument is missing';
  end if;

  -- Convert records to jsonb
  old_jsonb := to_jsonb(OLD);
  new_jsonb := to_jsonb(NEW);

  -- Get the column values and perform the merge
  merged_value := merge_update_jsonb(
    old_jsonb -> column_name,
    '{}',
    new_jsonb -> column_name
  );

  -- Update NEW with the merged value
  new_jsonb := jsonb_set(new_jsonb, array[column_name], merged_value);

  -- Convert back to record
  NEW := jsonb_populate_record(NEW, new_jsonb);

  return NEW;
end;
$$;
