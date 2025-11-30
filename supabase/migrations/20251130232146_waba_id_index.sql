CREATE INDEX organizations_addresses_waba_id_idx ON public.organizations_addresses USING btree (((extra ->> 'waba_id'::text))) WHERE (service = 'whatsapp'::public.service);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.create_log()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  waba_id text;
begin
  -- Try to find by organization_address first
  if new.organization_id is null and new.organization_address is not null then
    select organization_id into new.organization_id
    from public.organizations_addresses
    where address = new.organization_address;
  end if;

  -- If still null, try to find by waba_id in metadata
  if new.organization_id is null and new.metadata is not null then
    waba_id := coalesce(new.metadata->>'waba_id', new.metadata->'waba_info'->>'waba_id');
    
    if waba_id is not null then
      select organization_id, address into new.organization_id, new.organization_address
      from public.organizations_addresses
      where service = 'whatsapp' 
        and extra->>'waba_id' = waba_id
      order by updated_at desc
      limit 1;
    end if;
  end if;

  return new;
end;
$function$
;


