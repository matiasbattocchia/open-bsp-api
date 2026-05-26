-- Make public.get_authorized_orgs(role) return an empty set instead of
-- raising 42501 when the caller is authenticated-but-unauthorized, has no
-- matching API key, or is unauthenticated. The raise broke PostgreSQL's
-- permissive RLS OR semantics (any policy referencing this function would
-- abort the whole statement on no-match, masking sibling policies that
-- would have allowed the row). Most visible symptom: invitees could not
-- accept their own invitation on /conversations.
--
-- Hand-written rather than generated via `supabase db diff` because the
-- declarative schemas have pre-existing drift from production (missing
-- stripe billing columns in 06-07_subscriptions.sql, moddatetime schema
-- typo in 03-13_organization_secrets.sql, etc.) that makes `db diff`
-- emit catastrophic drops. This migration is the surgical fix only.
create or replace function public.get_authorized_orgs(role public.role default 'member') returns setof uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  req_level int;
  api_key text;
  org_id uuid;
begin
  req_level := case role::text
    when 'owner' then 3
    when 'admin' then 2
    else 1 -- 'member'
  end;

  -- First, try JWT authentication via auth.uid()
  if auth.uid() is not null then
    return query select organization_id from public.agents
    where
      user_id = auth.uid()
    and (
      extra->'invitation' is null
      or extra->'invitation'->>'status' = 'accepted'
    )
    and (
      case (extra->>'role')
        when 'owner' then 3
        when 'admin' then 2
        else 1 -- 'member'
      end
    ) >= req_level;

    if found then
      return;
    end if;

    return;
  end if;

  -- Fallback to API key authentication
  api_key := current_setting('request.headers', true)::json->>'api-key';

  if api_key is not null then
    select a.organization_id into org_id
    from public.api_keys a
    where a.key = api_key
    and (
      case (a.role::text)
        when 'owner' then 3
        when 'admin' then 2
        else 1 -- 'member'
      end
    ) >= req_level;

    if org_id is not null then
      return next org_id;
      return;
    end if;

    return;
  end if;

  return;
end;
$$;
