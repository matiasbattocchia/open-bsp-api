-- Update products unit constraint: mb -> gb
alter table billing.products drop constraint products_unit_check;
alter table billing.products add constraint products_unit_check check (unit in ('count', 'gb', 'usd'));

-- Update storage functions: MB -> GB (divide by 1e9 instead of 1e6)
CREATE OR REPLACE FUNCTION billing.check_storage_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _org_id uuid;
  _size_gb numeric;
begin
  _org_id := (string_to_array(new.name, '/'))[2]::uuid;
  _size_gb := coalesce((new.metadata->>'size')::numeric, 0) / 1000000000.0;

  perform billing.check_limit(_org_id, 'storage', _size_gb);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION billing.update_storage_usage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _org_id uuid;
  _size_gb numeric;
begin
  if tg_op = 'INSERT' then
    _org_id := (string_to_array(new.name, '/'))[2]::uuid;
    _size_gb := coalesce((new.metadata->>'size')::numeric, 0) / 1000000000.0;
    perform billing.update_usage(_org_id, 'storage', _size_gb);
    return new;
  elsif tg_op = 'DELETE' then
    _org_id := (string_to_array(old.name, '/'))[2]::uuid;
    _size_gb := coalesce((old.metadata->>'size')::numeric, 0) / 1000000000.0;
    perform billing.update_usage(_org_id, 'storage', -_size_gb);
    return old;
  end if;

  return coalesce(new, old);
end;
$function$;

-- Guard update_product_usage: skip when no billing products are defined
CREATE OR REPLACE FUNCTION billing.update_product_usage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _kind text;
begin
  -- No product = no billing
  select p.kind into _kind
  from billing.products p
  where p.id = tg_table_name;

  if not found then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if _kind = 'counter' then
      return old;
    end if;

    perform billing.update_usage(old.organization_id, tg_table_name, -1);
    return old;
  end if;

  perform billing.update_usage(new.organization_id, tg_table_name);
  return new;
end;
$function$;
