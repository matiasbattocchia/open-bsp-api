-- Check if a product limit allows usage for an organization.
-- Returns true if allowed, raises exception if blocked.
--  1. No subscription → allow (no billing)
--  2. No tiers_products row → allow (no limit)
--  3. Cap is null → unlimited, allow
--  4. Counter/gauge: usage + amount > cap → block
--  5. Balance: balance - amount < cap → block (cap is a floor, e.g. 0 or negative for debt)
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
  _kind text;
  _cap numeric;
  _interval text;
  _current numeric;
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

  -- Get product kind
  select p.kind into _kind
  from billing.products p
  where p.id = _product_id;

  -- No product = no billing for this resource
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

  -- Get current value
  select u.quantity into _current
  from billing.usage u
  where u.organization_id = _organization_id
    and u.product_id = _product_id
    and u.interval = _interval
    and u.period = _period;

  _current := coalesce(_current, 0);

  -- Balance products: cap is a floor (minimum allowed balance)
  -- e.g. cap=0 means no debt, cap=-5 allows up to $5 debt
  if _kind = 'balance' then
    if _current - _amount < _cap then
      raise exception 'Insufficient balance for %', _product_id;
    end if;
  else
    -- Counter/gauge: cap is a ceiling
    if _current + _amount > _cap then
      raise exception 'Usage limit reached for %', _product_id;
    end if;
  end if;

  return true;
end;
$$;

-- Generic: increment usage counters for a product.
-- Upserts day, month, and lifetime rows.
create function billing.update_usage(
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
  -- No product = no billing for this resource
  if not exists (select 1 from billing.products where id = _product_id) then
    return;
  end if;

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

-- Generic trigger: check limit before insert.
-- Product id is derived from the table name (e.g. messages, conversations).
create function billing.check_product_limit() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform billing.check_limit(new.organization_id, tg_table_name);
  return new;
end;
$$;

-- Generic trigger: update usage after insert or delete.
-- Product id is derived from the table name.
-- Counter products ignore delete; gauge products decrement on delete.
create function billing.update_product_usage() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  _kind text;
begin
  if tg_op = 'DELETE' then
    select p.kind into _kind
    from billing.products p
    where p.id = tg_table_name;

    if _kind = 'counter' then
      return old;
    end if;

    perform billing.update_usage(old.organization_id, tg_table_name, -1);
    return old;
  end if;

  perform billing.update_usage(new.organization_id, tg_table_name);
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
  _size_gb numeric;
begin
  _org_id := (string_to_array(new.name, '/'))[2]::uuid;
  _size_gb := coalesce((new.metadata->>'size')::numeric, 0) / 1000000000.0;

  perform billing.check_limit(_org_id, 'storage', _size_gb);
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
$$;

-- Trigger: update usage after ledger insert
-- Updates the lifetime balance and tracks daily/monthly cost stats.
-- Non-billable entries are recorded for analytics but don't affect balance.
create function billing.process_ledger_entry() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.billable is distinct from false then
    perform billing.update_usage(new.organization_id, new.product_id, new.quantity);
  end if;

  return new;
end;
$$;

-- Trigger: initialize subscription on organization insert.
-- Assigns the lowest-level active tier and default plan (if any).
-- No tiers = no billing.
create function billing.initialize_subscription() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  _tier_id text;
  _plan_id text;
begin
  select t.id into _tier_id
  from billing.tiers t
  where t.active = true
  order by t.level asc
  limit 1;

  if not found then
    return new;
  end if;

  -- Create subscription with tier only
  insert into billing.subscriptions (organization_id, tier_id)
  values (new.id, _tier_id);

  -- Assign default plan if one exists
  select p.id into _plan_id
  from billing.plans p
  where p.is_default = true
    and p.active = true
  limit 1;

  if _plan_id is not null then
    perform billing.change_plan(new.id, _plan_id);
  end if;

  return new;
end;
$$;

-- Change plan for an organization.
-- Updates tier (from plan's min_tier) and plan, sets period start, grants balance products.
-- Called by the app layer (service_role).
create function billing.change_plan(
  _organization_id uuid,
  _plan_id text
) returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  _plan billing.plans%rowtype;
  _tier_id text;
  _pp record;
begin
  -- Get the plan
  select * into strict _plan
  from billing.plans p
  where p.id = _plan_id
    and p.active = true;

  -- Find the matching tier for this plan's min_tier level
  select t.id into _tier_id
  from billing.tiers t
  where t.level >= _plan.min_tier
    and t.active = true
  order by t.level asc
  limit 1;

  if _tier_id is null then
    raise exception 'No active tier found for plan %', _plan_id;
  end if;

  -- Update subscription
  update billing.subscriptions
  set tier_id = _tier_id,
      plan_id = _plan_id,
      current_period_start = now()
  where organization_id = _organization_id;

  -- Grant balance products included in the plan
  for _pp in
    select pp.product_id, pp.included
    from billing.plans_products pp
    join billing.products p on p.id = pp.product_id
    where pp.plan_id = _plan_id
      and p.kind = 'balance'
      and pp.included is not null
      and pp.included > 0
  loop
    insert into billing.ledger (organization_id, product_id, type, quantity)
    values (_organization_id, _pp.product_id, 'grant', _pp.included);
  end loop;
end;
$$;

