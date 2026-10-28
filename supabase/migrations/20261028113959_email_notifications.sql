
  create table "billing"."alerts" (
    "organization_id" uuid not null,
    "product_id" text not null,
    "interval" text not null,
    "period" date not null,
    "level" text not null,
    "quantity" numeric not null,
    "cap" numeric not null,
    "created_at" timestamp with time zone not null default now()
      );


alter table "billing"."alerts" enable row level security;

CREATE UNIQUE INDEX alerts_pkey ON billing.alerts USING btree (organization_id, product_id, "interval", period, level);

alter table "billing"."alerts" add constraint "alerts_pkey" PRIMARY KEY using index "alerts_pkey";

alter table "billing"."alerts" add constraint "alerts_level_check" CHECK ((level = ANY (ARRAY['near'::text, 'capped'::text]))) not valid;

alter table "billing"."alerts" validate constraint "alerts_level_check";

alter table "billing"."alerts" add constraint "alerts_usage_fkey" FOREIGN KEY (organization_id, product_id, "interval", period) REFERENCES billing.usage(organization_id, product_id, "interval", period) ON DELETE CASCADE not valid;

alter table "billing"."alerts" validate constraint "alerts_usage_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION billing.quota_level(_kind text, _quantity numeric, _cap numeric, _grant numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when _cap is null then 'ok'
    when _kind = 'balance' then
      case
        when _quantity <= _cap then 'capped'
        when coalesce(_grant, 0) - _cap > 0
          and _quantity - _cap <= (coalesce(_grant, 0) - _cap) * 0.2 then 'near'
        else 'ok'
      end
    when _quantity >= _cap then 'capped'
    when _quantity >= _cap * 0.8 then 'near'
    else 'ok'
  end
$function$
;

CREATE OR REPLACE FUNCTION billing.track_quota_alerts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  _kind text;
  _cap numeric;
  _interval text;
  _grant numeric;
  _before text;
  _after text;
  _rank jsonb := '{"ok": 0, "near": 1, "capped": 2}';
begin
  select p.kind, tp.cap, tp.interval, pp.included
  into _kind, _cap, _interval, _grant
  from billing.subscriptions s
  join billing.tiers_products tp
    on tp.tier_id = s.tier_id and tp.product_id = new.product_id
  join billing.products p on p.id = new.product_id
  left join billing.plans_products pp
    on pp.plan_id = s.plan_id and pp.product_id = new.product_id
  where s.organization_id = new.organization_id;

  if not found or _cap is null or _interval <> new.interval then
    return null;
  end if;

  _before := billing.quota_level(
    _kind,
    case when tg_op = 'UPDATE' then old.quantity else 0 end,
    _cap,
    _grant
  );
  _after := billing.quota_level(_kind, new.quantity, _cap, _grant);

  if _after = _before then
    return null;
  end if;

  delete from billing.alerts a
  where a.organization_id = new.organization_id
    and a.product_id = new.product_id
    and a.interval = new.interval
    and a.period = new.period
    and (_rank ->> a.level)::int > (_rank ->> _after)::int;

  if (_rank ->> _after)::int > (_rank ->> _before)::int then
    insert into billing.alerts
      (organization_id, product_id, interval, period, level, quantity, cap)
    values
      (new.organization_id, new.product_id, new.interval, new.period, _after, new.quantity, _cap)
    on conflict do nothing;
  end if;

  return null;
end;
$function$
;

grant select on table "billing"."alerts" to "anon";

grant select on table "billing"."alerts" to "authenticated";

grant insert on table "billing"."alerts" to "service_role";

grant select on table "billing"."alerts" to "service_role";

grant update on table "billing"."alerts" to "service_role";


  create policy "members can read their org alerts"
  on "billing"."alerts"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));


CREATE TRIGGER notify_billing_alert AFTER INSERT ON billing.alerts FOR EACH ROW EXECUTE FUNCTION public.edge_function('/notifications', 'post');

CREATE TRIGGER track_billing_quota_alerts AFTER INSERT OR UPDATE OF quantity ON billing.usage FOR EACH ROW WHEN ((new."interval" <> 'day'::text)) EXECUTE FUNCTION billing.track_quota_alerts();

CREATE TRIGGER notify_invitation_accepted AFTER UPDATE OF status ON public.invitations FOR EACH ROW WHEN (((old.status = 'pending'::text) AND (new.status = 'accepted'::text))) EXECUTE FUNCTION public.edge_function('/notifications', 'post');

CREATE TRIGGER notify_invitation_received AFTER INSERT ON public.invitations FOR EACH ROW WHEN ((new.status = 'pending'::text)) EXECUTE FUNCTION public.edge_function('/notifications', 'post');



-- A new billing function is born executable by PUBLIC (see 06-40_grants.sql).
revoke execute on all functions in schema billing from public;

grant execute on all functions in schema billing to service_role;
