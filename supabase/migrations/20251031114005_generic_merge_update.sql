drop trigger if exists "set_extra" on "public"."agents";

drop trigger if exists "set_extra" on "public"."contacts";

drop trigger if exists "set_extra" on "public"."conversations";

drop trigger if exists "set_message" on "public"."messages";

drop trigger if exists "set_status" on "public"."messages";

drop trigger if exists "set_extra" on "public"."organizations";

drop trigger if exists "set_extra" on "public"."organizations_addresses";

drop function if exists "public"."merge_update_content"();

drop function if exists "public"."merge_update_extra"();

drop function if exists "public"."merge_update_status"();

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
    '{}',
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

CREATE TRIGGER set_extra BEFORE UPDATE ON public.agents FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION public.merge_update('extra');

CREATE TRIGGER set_extra BEFORE UPDATE ON public.contacts FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION public.merge_update('extra');

CREATE TRIGGER set_extra BEFORE UPDATE ON public.conversations FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION public.merge_update('extra');

CREATE TRIGGER set_message BEFORE UPDATE ON public.messages FOR EACH ROW WHEN ((new.content IS NOT NULL)) EXECUTE FUNCTION public.merge_update('content');

CREATE TRIGGER set_status BEFORE UPDATE ON public.messages FOR EACH ROW WHEN ((new.status IS NOT NULL)) EXECUTE FUNCTION public.merge_update('status');

CREATE TRIGGER set_extra BEFORE UPDATE ON public.organizations FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION public.merge_update('extra');

CREATE TRIGGER set_extra BEFORE UPDATE ON public.organizations_addresses FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION public.merge_update('extra');
