set check_function_bodies = off;

CREATE OR REPLACE FUNCTION billing.update_account_usage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _org_id uuid := coalesce(new.organization_id, old.organization_id);
  _old int := 0;
  _new int := 0;
begin
  if tg_op <> 'INSERT' then
    _old := (old.service not in ('local', 'slack') and old.status = 'connected')::int;
  end if;

  if tg_op <> 'DELETE' then
    _new := (new.service not in ('local', 'slack') and new.status = 'connected')::int;
  end if;

  if _new = _old then
    return null;
  end if;

  -- Cascade from an organization delete: its billing rows are going too, and
  -- there is no usage to credit back.
  if not exists (select 1 from public.organizations where id = _org_id) then
    return null;
  end if;

  if _new > _old then
    perform billing.check_limit(_org_id, tg_table_name);
  end if;

  perform billing.update_usage(_org_id, tg_table_name, _new - _old);
  return null;
end;
$function$
;


