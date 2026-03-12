set check_function_bodies = off;

CREATE OR REPLACE FUNCTION billing.guard_ledger_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (select 1 from billing.products where id = new.product_id) then
    return null;
  end if;
  return new;
end;
$function$
;

CREATE TRIGGER a_guard_billing_ledger_product BEFORE INSERT ON billing.ledger FOR EACH ROW EXECUTE FUNCTION billing.guard_ledger_insert();


