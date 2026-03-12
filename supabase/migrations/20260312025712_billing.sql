create schema if not exists "billing";

grant usage on schema billing to anon, authenticated;
alter default privileges in schema billing grant select on tables to anon, authenticated;
alter default privileges in schema billing revoke execute on functions from public;

drop trigger if exists "check_org_limit" on "public"."agents";

drop trigger if exists "check_org_limit" on "public"."organizations";

drop function if exists "public"."check_org_limit_before_insert_on_organizations"();

drop function if exists "public"."check_org_limit_before_update_on_agents"();


  create table "billing"."accounts" (
    "id" uuid not null default gen_random_uuid(),
    "name" text not null,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."accounts" enable row level security;


  create table "billing"."costs" (
    "provider" text not null,
    "product" text not null,
    "effective_at" timestamp with time zone not null default now(),
    "quantity" numeric not null,
    "unit" text not null,
    "pricing" jsonb not null,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."costs" enable row level security;


  create table "billing"."invoices" (
    "id" uuid not null default gen_random_uuid(),
    "organization_id" uuid not null,
    "period_start" timestamp with time zone,
    "period_end" timestamp with time zone,
    "status" text not null default 'draft'::text,
    "subtotal" numeric not null default 0,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."invoices" enable row level security;


  create table "billing"."invoices_items" (
    "id" uuid not null default gen_random_uuid(),
    "invoice_id" uuid not null,
    "type" text not null,
    "plan_id" text,
    "product_id" text,
    "ledger_id" uuid,
    "quantity" numeric not null,
    "unit_price" numeric not null,
    "amount" numeric not null,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."invoices_items" enable row level security;


  create table "billing"."ledger" (
    "id" uuid not null default gen_random_uuid(),
    "organization_id" uuid not null,
    "product_id" text not null,
    "type" text not null,
    "quantity" numeric not null,
    "agent_id" uuid,
    "message_id" uuid,
    "provider" text,
    "model" text,
    "metadata" jsonb,
    "billable" boolean,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."ledger" enable row level security;


  create table "billing"."payments" (
    "id" uuid not null default gen_random_uuid(),
    "invoice_id" uuid not null,
    "organization_id" uuid not null,
    "account_id" uuid,
    "amount" numeric not null,
    "method" text,
    "status" text not null default 'pending'::text,
    "external_id" text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."payments" enable row level security;


  create table "billing"."plans" (
    "id" text not null,
    "min_tier" integer not null,
    "price" numeric not null,
    "billing_cycle" text,
    "is_default" boolean not null default false,
    "active" boolean not null default true,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."plans" enable row level security;


  create table "billing"."plans_products" (
    "plan_id" text not null,
    "product_id" text not null,
    "interval" text not null,
    "included" numeric,
    "unit_price" numeric,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."plans_products" enable row level security;


  create table "billing"."products" (
    "id" text not null,
    "name" text not null,
    "unit" text not null,
    "kind" text not null,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."products" enable row level security;


  create table "billing"."subscriptions" (
    "organization_id" uuid not null,
    "tier_id" text not null,
    "plan_id" text,
    "account_id" uuid,
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."subscriptions" enable row level security;


  create table "billing"."tiers" (
    "id" text not null,
    "name" text not null,
    "level" integer not null default 0,
    "active" boolean not null default true,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."tiers" enable row level security;


  create table "billing"."tiers_products" (
    "tier_id" text not null,
    "product_id" text not null,
    "interval" text not null,
    "cap" numeric,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."tiers_products" enable row level security;


  create table "billing"."usage" (
    "organization_id" uuid not null,
    "product_id" text not null,
    "interval" text not null default 'lifetime'::text,
    "period" date not null default '1970-01-01'::date,
    "quantity" numeric not null default 0,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "billing"."usage" enable row level security;

CREATE UNIQUE INDEX accounts_pkey ON billing.accounts USING btree (id);

CREATE UNIQUE INDEX costs_pkey ON billing.costs USING btree (provider, product, effective_at);

CREATE INDEX invoices_items_invoice_id_idx ON billing.invoices_items USING btree (invoice_id);

CREATE UNIQUE INDEX invoices_items_pkey ON billing.invoices_items USING btree (id);

CREATE INDEX invoices_organization_id_idx ON billing.invoices USING btree (organization_id);

CREATE UNIQUE INDEX invoices_pkey ON billing.invoices USING btree (id);

CREATE INDEX ledger_created_at_idx ON billing.ledger USING btree (created_at);

CREATE INDEX ledger_organization_id_idx ON billing.ledger USING btree (organization_id);

CREATE UNIQUE INDEX ledger_pkey ON billing.ledger USING btree (id);

CREATE INDEX payments_invoice_id_idx ON billing.payments USING btree (invoice_id);

CREATE INDEX payments_organization_id_idx ON billing.payments USING btree (organization_id);

CREATE UNIQUE INDEX payments_pkey ON billing.payments USING btree (id);

CREATE UNIQUE INDEX plans_pkey ON billing.plans USING btree (id);

CREATE UNIQUE INDEX plans_products_pkey ON billing.plans_products USING btree (plan_id, product_id);

CREATE UNIQUE INDEX products_pkey ON billing.products USING btree (id);

CREATE UNIQUE INDEX subscriptions_pkey ON billing.subscriptions USING btree (organization_id);

CREATE UNIQUE INDEX tiers_pkey ON billing.tiers USING btree (id);

CREATE UNIQUE INDEX tiers_products_pkey ON billing.tiers_products USING btree (tier_id, product_id);

CREATE UNIQUE INDEX usage_pkey ON billing.usage USING btree (organization_id, product_id, "interval", period);

alter table "billing"."accounts" add constraint "accounts_pkey" PRIMARY KEY using index "accounts_pkey";

alter table "billing"."costs" add constraint "costs_pkey" PRIMARY KEY using index "costs_pkey";

alter table "billing"."invoices" add constraint "invoices_pkey" PRIMARY KEY using index "invoices_pkey";

alter table "billing"."invoices_items" add constraint "invoices_items_pkey" PRIMARY KEY using index "invoices_items_pkey";

alter table "billing"."ledger" add constraint "ledger_pkey" PRIMARY KEY using index "ledger_pkey";

alter table "billing"."payments" add constraint "payments_pkey" PRIMARY KEY using index "payments_pkey";

alter table "billing"."plans" add constraint "plans_pkey" PRIMARY KEY using index "plans_pkey";

alter table "billing"."plans_products" add constraint "plans_products_pkey" PRIMARY KEY using index "plans_products_pkey";

alter table "billing"."products" add constraint "products_pkey" PRIMARY KEY using index "products_pkey";

alter table "billing"."subscriptions" add constraint "subscriptions_pkey" PRIMARY KEY using index "subscriptions_pkey";

alter table "billing"."tiers" add constraint "tiers_pkey" PRIMARY KEY using index "tiers_pkey";

alter table "billing"."tiers_products" add constraint "tiers_products_pkey" PRIMARY KEY using index "tiers_products_pkey";

alter table "billing"."usage" add constraint "usage_pkey" PRIMARY KEY using index "usage_pkey";

alter table "billing"."invoices" add constraint "invoices_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "billing"."invoices" validate constraint "invoices_organization_id_fkey";

alter table "billing"."invoices" add constraint "invoices_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'issued'::text, 'paid'::text, 'void'::text]))) not valid;

alter table "billing"."invoices" validate constraint "invoices_status_check";

alter table "billing"."invoices_items" add constraint "invoices_items_invoice_id_fkey" FOREIGN KEY (invoice_id) REFERENCES billing.invoices(id) ON DELETE CASCADE not valid;

alter table "billing"."invoices_items" validate constraint "invoices_items_invoice_id_fkey";

alter table "billing"."invoices_items" add constraint "invoices_items_ledger_id_fkey" FOREIGN KEY (ledger_id) REFERENCES billing.ledger(id) not valid;

alter table "billing"."invoices_items" validate constraint "invoices_items_ledger_id_fkey";

alter table "billing"."invoices_items" add constraint "invoices_items_plan_id_fkey" FOREIGN KEY (plan_id) REFERENCES billing.plans(id) not valid;

alter table "billing"."invoices_items" validate constraint "invoices_items_plan_id_fkey";

alter table "billing"."invoices_items" add constraint "invoices_items_product_id_fkey" FOREIGN KEY (product_id) REFERENCES billing.products(id) not valid;

alter table "billing"."invoices_items" validate constraint "invoices_items_product_id_fkey";

alter table "billing"."invoices_items" add constraint "invoices_items_type_check" CHECK ((type = ANY (ARRAY['plan'::text, 'credit'::text, 'overage'::text]))) not valid;

alter table "billing"."invoices_items" validate constraint "invoices_items_type_check";

alter table "billing"."ledger" add constraint "ledger_agent_id_fkey" FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL not valid;

alter table "billing"."ledger" validate constraint "ledger_agent_id_fkey";

alter table "billing"."ledger" add constraint "ledger_message_id_fkey" FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE SET NULL not valid;

alter table "billing"."ledger" validate constraint "ledger_message_id_fkey";

alter table "billing"."ledger" add constraint "ledger_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "billing"."ledger" validate constraint "ledger_organization_id_fkey";

alter table "billing"."ledger" add constraint "ledger_product_id_fkey" FOREIGN KEY (product_id) REFERENCES billing.products(id) not valid;

alter table "billing"."ledger" validate constraint "ledger_product_id_fkey";

alter table "billing"."ledger" add constraint "ledger_type_check" CHECK ((type = ANY (ARRAY['grant'::text, 'consumption'::text, 'topup'::text]))) not valid;

alter table "billing"."ledger" validate constraint "ledger_type_check";

alter table "billing"."payments" add constraint "payments_account_id_fkey" FOREIGN KEY (account_id) REFERENCES billing.accounts(id) not valid;

alter table "billing"."payments" validate constraint "payments_account_id_fkey";

alter table "billing"."payments" add constraint "payments_invoice_id_fkey" FOREIGN KEY (invoice_id) REFERENCES billing.invoices(id) ON DELETE CASCADE not valid;

alter table "billing"."payments" validate constraint "payments_invoice_id_fkey";

alter table "billing"."payments" add constraint "payments_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "billing"."payments" validate constraint "payments_organization_id_fkey";

alter table "billing"."payments" add constraint "payments_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'refunded'::text]))) not valid;

alter table "billing"."payments" validate constraint "payments_status_check";

alter table "billing"."plans" add constraint "plans_billing_cycle_check" CHECK ((billing_cycle = ANY (ARRAY['month'::text, 'year'::text]))) not valid;

alter table "billing"."plans" validate constraint "plans_billing_cycle_check";

alter table "billing"."plans_products" add constraint "plans_products_interval_check" CHECK (("interval" = ANY (ARRAY['month'::text, 'lifetime'::text]))) not valid;

alter table "billing"."plans_products" validate constraint "plans_products_interval_check";

alter table "billing"."plans_products" add constraint "plans_products_plan_id_fkey" FOREIGN KEY (plan_id) REFERENCES billing.plans(id) ON DELETE CASCADE not valid;

alter table "billing"."plans_products" validate constraint "plans_products_plan_id_fkey";

alter table "billing"."plans_products" add constraint "plans_products_product_id_fkey" FOREIGN KEY (product_id) REFERENCES billing.products(id) ON DELETE CASCADE not valid;

alter table "billing"."plans_products" validate constraint "plans_products_product_id_fkey";

alter table "billing"."products" add constraint "products_kind_check" CHECK ((kind = ANY (ARRAY['counter'::text, 'gauge'::text, 'balance'::text]))) not valid;

alter table "billing"."products" validate constraint "products_kind_check";

alter table "billing"."products" add constraint "products_unit_check" CHECK ((unit = ANY (ARRAY['count'::text, 'mb'::text, 'usd'::text]))) not valid;

alter table "billing"."products" validate constraint "products_unit_check";

alter table "billing"."subscriptions" add constraint "subscriptions_account_id_fkey" FOREIGN KEY (account_id) REFERENCES billing.accounts(id) not valid;

alter table "billing"."subscriptions" validate constraint "subscriptions_account_id_fkey";

alter table "billing"."subscriptions" add constraint "subscriptions_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "billing"."subscriptions" validate constraint "subscriptions_organization_id_fkey";

alter table "billing"."subscriptions" add constraint "subscriptions_plan_id_fkey" FOREIGN KEY (plan_id) REFERENCES billing.plans(id) not valid;

alter table "billing"."subscriptions" validate constraint "subscriptions_plan_id_fkey";

alter table "billing"."subscriptions" add constraint "subscriptions_tier_id_fkey" FOREIGN KEY (tier_id) REFERENCES billing.tiers(id) not valid;

alter table "billing"."subscriptions" validate constraint "subscriptions_tier_id_fkey";

alter table "billing"."tiers_products" add constraint "tiers_products_interval_check" CHECK (("interval" = ANY (ARRAY['month'::text, 'lifetime'::text]))) not valid;

alter table "billing"."tiers_products" validate constraint "tiers_products_interval_check";

alter table "billing"."tiers_products" add constraint "tiers_products_product_id_fkey" FOREIGN KEY (product_id) REFERENCES billing.products(id) ON DELETE CASCADE not valid;

alter table "billing"."tiers_products" validate constraint "tiers_products_product_id_fkey";

alter table "billing"."tiers_products" add constraint "tiers_products_tier_id_fkey" FOREIGN KEY (tier_id) REFERENCES billing.tiers(id) ON DELETE CASCADE not valid;

alter table "billing"."tiers_products" validate constraint "tiers_products_tier_id_fkey";

alter table "billing"."usage" add constraint "usage_interval_check" CHECK (("interval" = ANY (ARRAY['day'::text, 'month'::text, 'lifetime'::text]))) not valid;

alter table "billing"."usage" validate constraint "usage_interval_check";

alter table "billing"."usage" add constraint "usage_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "billing"."usage" validate constraint "usage_organization_id_fkey";

alter table "billing"."usage" add constraint "usage_product_id_fkey" FOREIGN KEY (product_id) REFERENCES billing.products(id) ON DELETE CASCADE not valid;

alter table "billing"."usage" validate constraint "usage_product_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION billing.change_plan(_organization_id uuid, _plan_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION billing.check_limit(_organization_id uuid, _product_id text, _amount numeric DEFAULT 1)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION billing.check_product_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform billing.check_limit(new.organization_id, tg_table_name);
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION billing.check_storage_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _org_id uuid;
  _size_mb numeric;
begin
  _org_id := (string_to_array(new.name, '/'))[2]::uuid;
  _size_mb := coalesce((new.metadata->>'size')::numeric, 0) / 1000000.0;

  perform billing.check_limit(_org_id, 'storage', _size_mb);
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION billing.initialize_subscription()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION billing.process_ledger_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.billable is distinct from false then
    perform billing.update_usage(new.organization_id, new.product_id, new.quantity);
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION billing.update_product_usage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION billing.update_storage_usage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _org_id uuid;
  _size_mb numeric;
begin
  if tg_op = 'INSERT' then
    _org_id := (string_to_array(new.name, '/'))[2]::uuid;
    _size_mb := coalesce((new.metadata->>'size')::numeric, 0) / 1000000.0;
    perform billing.update_usage(_org_id, 'storage', _size_mb);
    return new;
  elsif tg_op = 'DELETE' then
    _org_id := (string_to_array(old.name, '/'))[2]::uuid;
    _size_mb := coalesce((old.metadata->>'size')::numeric, 0) / 1000000.0;
    perform billing.update_usage(_org_id, 'storage', -_size_mb);
    return old;
  end if;

  return coalesce(new, old);
end;
$function$
;

CREATE OR REPLACE FUNCTION billing.update_usage(_organization_id uuid, _product_id text, _quantity numeric DEFAULT 1)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

grant select on table "billing"."accounts" to "anon";

grant select on table "billing"."accounts" to "authenticated";

grant select on table "billing"."costs" to "anon";

grant select on table "billing"."costs" to "authenticated";

grant select on table "billing"."invoices" to "anon";

grant select on table "billing"."invoices" to "authenticated";

grant select on table "billing"."invoices_items" to "anon";

grant select on table "billing"."invoices_items" to "authenticated";

grant select on table "billing"."ledger" to "anon";

grant select on table "billing"."ledger" to "authenticated";

grant select on table "billing"."payments" to "anon";

grant select on table "billing"."payments" to "authenticated";

grant select on table "billing"."plans" to "anon";

grant select on table "billing"."plans" to "authenticated";

grant select on table "billing"."plans_products" to "anon";

grant select on table "billing"."plans_products" to "authenticated";

grant select on table "billing"."products" to "anon";

grant select on table "billing"."products" to "authenticated";

grant select on table "billing"."subscriptions" to "anon";

grant select on table "billing"."subscriptions" to "authenticated";

grant select on table "billing"."tiers" to "anon";

grant select on table "billing"."tiers" to "authenticated";

grant select on table "billing"."tiers_products" to "anon";

grant select on table "billing"."tiers_products" to "authenticated";

grant select on table "billing"."usage" to "anon";

grant select on table "billing"."usage" to "authenticated";


  create policy "owners can read their accounts"
  on "billing"."accounts"
  as permissive
  for select
  to authenticated, anon
using ((id IN ( SELECT s.account_id
   FROM billing.subscriptions s
  WHERE ((s.organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)) AND (s.account_id IS NOT NULL)))));



  create policy "anyone can read costs"
  on "billing"."costs"
  as permissive
  for select
  to authenticated, anon
using (true);



  create policy "owners can read their org invoices"
  on "billing"."invoices"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));



  create policy "owners can read their org invoice items"
  on "billing"."invoices_items"
  as permissive
  for select
  to authenticated, anon
using ((invoice_id IN ( SELECT i.id
   FROM billing.invoices i
  WHERE (i.organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)))));



  create policy "members can read their org ledger"
  on "billing"."ledger"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));



  create policy "owners can read their org payments"
  on "billing"."payments"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));



  create policy "anyone can read plans"
  on "billing"."plans"
  as permissive
  for select
  to authenticated, anon
using (true);



  create policy "anyone can read plans_products"
  on "billing"."plans_products"
  as permissive
  for select
  to authenticated, anon
using (true);



  create policy "anyone can read products"
  on "billing"."products"
  as permissive
  for select
  to authenticated, anon
using (true);



  create policy "members can read their org subscription"
  on "billing"."subscriptions"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));



  create policy "anyone can read tiers"
  on "billing"."tiers"
  as permissive
  for select
  to authenticated, anon
using (true);



  create policy "anyone can read tiers_products"
  on "billing"."tiers_products"
  as permissive
  for select
  to authenticated, anon
using (true);



  create policy "members can read their org usage"
  on "billing"."usage"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));


CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.accounts FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.costs FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.invoices FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.invoices_items FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.ledger FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER update_billing_ledger_usage AFTER INSERT ON billing.ledger FOR EACH ROW EXECUTE FUNCTION billing.process_ledger_entry();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.payments FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.plans FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.plans_products FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.products FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.subscriptions FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.tiers FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.tiers_products FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing.usage FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');

CREATE TRIGGER check_billing_conversation_limit BEFORE INSERT ON public.conversations FOR EACH ROW EXECUTE FUNCTION billing.check_product_limit();

CREATE TRIGGER update_billing_conversation_usage AFTER INSERT OR DELETE ON public.conversations FOR EACH ROW EXECUTE FUNCTION billing.update_product_usage();

CREATE TRIGGER check_billing_message_limit BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION billing.check_product_limit();

CREATE TRIGGER update_billing_message_usage AFTER INSERT OR DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION billing.update_product_usage();

CREATE TRIGGER initialize_billing_subscription AFTER INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION billing.initialize_subscription();

CREATE TRIGGER check_billing_storage_limit BEFORE INSERT ON storage.objects FOR EACH ROW EXECUTE FUNCTION billing.check_storage_limit();

CREATE TRIGGER update_billing_storage_usage AFTER INSERT OR DELETE ON storage.objects FOR EACH ROW EXECUTE FUNCTION billing.update_storage_usage();

grant select on all tables in schema billing to anon, authenticated;
