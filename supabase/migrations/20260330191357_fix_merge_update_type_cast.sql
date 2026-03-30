set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.merge_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
    '{}'::text[],
    new_jsonb -> column_name
  );

  -- Update NEW with the merged value
  new_jsonb := jsonb_set(new_jsonb, array[column_name], merged_value);

  -- Convert back to record
  NEW := jsonb_populate_record(NEW, new_jsonb);

  return NEW;
end;
$function$
;


