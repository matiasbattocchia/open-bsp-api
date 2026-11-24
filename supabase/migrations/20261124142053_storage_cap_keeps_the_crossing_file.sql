set check_function_bodies = off;

CREATE OR REPLACE FUNCTION billing.check_storage_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _org_id uuid;
begin
  _org_id := (string_to_array(new.name, '/'))[2]::uuid;

  -- A file is refused once storage is past the cap, not for crossing it: the
  -- one that crosses is kept (at most one file over). Refusing it instead
  -- would stall usage just short of the cap, where it never reads as capped,
  -- so the 'capped' alert would never go out — a refusal rolls back, and
  -- records nothing.
  perform billing.check_limit(_org_id, 'storage', 0);
  return new;
end;
$function$
;


