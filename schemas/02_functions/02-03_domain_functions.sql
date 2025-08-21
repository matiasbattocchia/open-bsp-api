create function "public"."bulk_update_messages_status"("records" "jsonb") returns "void"
    language "plpgsql"
    as $$
begin
  update messages o
  set status = r.status
  from (
    select * from jsonb_populate_recordset(null::messages, records)
  ) r
  where o.external_id = r.external_id;
end;
$$;

create function "public"."create_conversation"() returns "trigger"
    language "plpgsql"
    as $_$
declare
  service_id text := new.service || '_id';
begin
  assert new.name is not null, 'provide a name for the new contact in the "name" column';

  execute format('
    select oa.organization_id, c.id as contact_id
    from public.organizations_addresses as oa
    left join public.contacts as c
    on oa.organization_id = c.organization_id
    and c.extra->>%L = %L
    where oa.address = %L', 
    service_id, new.contact_address, new.organization_address
  ) into new.organization_id, new.contact_id;

  if new.contact_id is null then
    execute 'insert into public.contacts (organization_id, name, extra)
    values ($1, $2, $3)
    on conflict (organization_id, (extra->>' || quote_literal(service_id) || ')) do nothing
    returning id' into new.contact_id using new.organization_id, new.name, jsonb_build_object(service_id, new.contact_address);
  end if;

  return new;
end;
$_$;

create function "public"."create_organization"() returns "trigger"
    language "plpgsql"
    as $$
declare
  org_id uuid := new.id;
  org_address text := org_id::text;
begin
  insert into public.organizations_addresses (organization_id, service, address)
    values (org_id, 'local', org_address);

  return new;
end;
$$;

create function "public"."mark_outgoing_local_message_as_sent"() returns "trigger"
    language "plpgsql"
    as $$
begin
  new.status := merge_update_jsonb(new.status, '{}', jsonb_build_object('delivered', now()));
  new.updated_at := now() + interval '10 second';

  return new;
end;
$$; 