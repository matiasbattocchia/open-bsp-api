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

create function public.get_authorized_orgs(role text default 'member') returns setof uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  req_level int;
begin
  req_level := case role
    when 'owner' then 3
    when 'admin' then 2
    else 1 -- 'member'
  end;

  return query select organization_id from public.agents where user_id = auth.uid()
  and (
    case (extra->>'role')
      when 'owner' then 3
      when 'admin' then 2
      else 1 -- 'member'
    end
  ) >= req_level;
end;
$$;

/*
-- Note: this function should not be needed, because the above implementation has a default value.
-- Albait, many policies use this signature, so we keep it for now.
create function public.get_authorized_orgs() returns setof uuid
language plpgsql
security definer
set search_path to ''
as $$
begin
  return query select * from public.get_authorized_orgs('member');
end;
$$; 
*/