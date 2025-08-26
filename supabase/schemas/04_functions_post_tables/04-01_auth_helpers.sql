create function public.get_authorized_org_by_api_key() returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  api_key text := current_setting('request.headers', true)::json->>'x-app-api-key';
  org_id uuid;
begin
  select organization_id from public.api_keys where key = api_key into org_id;

  if org_id is not null then
    return org_id;
  end if;

  raise exception using
    errcode = '42501',
    message = 'no registered api key found in x-app-api-key header';
end;
$$;

create function public.get_authorized_orgs() returns setof uuid
language plpgsql
security definer
set search_path to ''
as $$
begin
  return query select organization_id from public.agents where user_id = auth.uid();
end;
$$;

create function public.get_authorized_orgs(role text) returns setof uuid
language plpgsql
security definer
set search_path to ''
as $$
begin
  return query select organization_id from public.agents where user_id = auth.uid()
  and role in (select jsonb_array_elements_text(extra->'roles'));
end;
$$; 