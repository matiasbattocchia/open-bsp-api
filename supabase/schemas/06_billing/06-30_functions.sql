-- Check if a product limit allows usage for an organization.
-- Returns true if allowed, raises exception if blocked.
--  1. Get tier_id from subscription (no subscription → allow)
--  2. Get cap and interval from tiers_products (no row → allow)
--  3. cap is null → unlimited, allow
--  4. Get current usage from billing.usage for the correct interval/period
--  5. usage + amount >= cap → block
create function billing.check_limit(
  _organization_id uuid,
  _product_id text,
  _amount numeric default 1
) returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  _tier_id text;
  _cap numeric;
  _interval text;
  _current_usage numeric;
  _period date;
begin
  -- Get tier from subscription
  select s.tier_id into _tier_id
  from billing.subscriptions s
  where s.organization_id = _organization_id;

  -- No subscription = no billing = allow
  if not found then
    return true;
  end if;

  -- Get tier cap and interval
  select tp.cap, tp.interval
  into _cap, _interval
  from billing.tiers_products tp
  where tp.tier_id = _tier_id
    and tp.product_id = _product_id;

  -- No tier_product row = no limit for this product
  if not found then
    return true;
  end if;

  -- Cap is null = unlimited
  if _cap is null then
    return true;
  end if;

  -- Determine the period to check
  _period := case _interval
    when 'month' then date_trunc('month', current_date)::date
    when 'day' then current_date
    else '1970-01-01'::date
  end;

  -- Get current usage
  select u.quantity into _current_usage
  from billing.usage u
  where u.organization_id = _organization_id
    and u.product_id = _product_id
    and u.interval = _interval
    and u.period = _period;

  if _current_usage is null then
    _current_usage := 0;
  end if;

  -- Check cap (current + incoming amount)
  if _current_usage + _amount > _cap then
    raise exception 'Usage limit reached for %', _product_id;
  end if;

  return true;
end;
$$;

-- Generic: increment usage counters for a product.
-- Upserts day, month, and lifetime rows.
create function billing.increment_usage(
  _organization_id uuid,
  _product_id text,
  _quantity numeric default 1
) returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _today date := current_date;
  _month date := date_trunc('month', current_date)::date;
begin
  -- Upsert day
  insert into billing.usage (organization_id, product_id, interval, period, quantity)
  values (_organization_id, _product_id, 'day', _today, _quantity)
  on conflict (organization_id, product_id, interval, period)
  do update set quantity = billing.usage.quantity + _quantity;

  -- Upsert month
  insert into billing.usage (organization_id, product_id, interval, period, quantity)
  values (_organization_id, _product_id, 'month', _month, _quantity)
  on conflict (organization_id, product_id, interval, period)
  do update set quantity = billing.usage.quantity + _quantity;

  -- Upsert lifetime
  insert into billing.usage (organization_id, product_id, interval, period, quantity)
  values (_organization_id, _product_id, 'lifetime', '1970-01-01', _quantity)
  on conflict (organization_id, product_id, interval, period)
  do update set quantity = billing.usage.quantity + _quantity;
end;
$$;

-- Trigger: check message limit before insert
create function billing.check_message_limit() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform billing.check_limit(new.organization_id, 'messages');
  return new;
end;
$$;

-- Trigger: increment message usage after insert
create function billing.increment_message_usage() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform billing.increment_usage(new.organization_id, 'messages');
  return new;
end;
$$;

-- Trigger: check conversation limit before insert
create function billing.check_conversation_limit() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform billing.check_limit(new.organization_id, 'conversations');
  return new;
end;
$$;

-- Trigger: increment conversation usage after insert
create function billing.increment_conversation_usage() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform billing.increment_usage(new.organization_id, 'conversations');
  return new;
end;
$$;

-- Trigger: check storage limit before upload
-- Path convention: organizations/<org_id>/attachments/<file_id>
create function billing.check_storage_limit() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  _org_id uuid;
  _size_mb numeric;
begin
  _org_id := (string_to_array(new.name, '/'))[2]::uuid;
  _size_mb := coalesce((new.metadata->>'size')::numeric, 0) / 1000000.0;

  perform billing.check_limit(_org_id, 'storage', _size_mb);
  return new;
end;
$$;

-- Trigger: update storage usage after insert or delete
-- Path convention: organizations/<org_id>/attachments/<file_id>
create function billing.update_storage_usage() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  _org_id uuid;
  _size_mb numeric;
begin
  if tg_op = 'INSERT' then
    _org_id := (string_to_array(new.name, '/'))[2]::uuid;
    _size_mb := coalesce((new.metadata->>'size')::numeric, 0) / 1000000.0;
    perform billing.increment_usage(_org_id, 'storage', _size_mb);
    return new;
  elsif tg_op = 'DELETE' then
    _org_id := (string_to_array(old.name, '/'))[2]::uuid;
    _size_mb := coalesce((old.metadata->>'size')::numeric, 0) / 1000000.0;
    perform billing.increment_usage(_org_id, 'storage', -_size_mb);
    return old;
  end if;

  return coalesce(new, old);
end;
$$;
