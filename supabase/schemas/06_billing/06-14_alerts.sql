-- A quota crossing a threshold: near the cap (80%, as the UI's quotaStatus
-- reads it) or at it. One row per level per usage period, so a level is
-- announced once — billing.track_quota_alerts writes these from usage and
-- removes the ones that no longer hold when usage recovers (a freed file, a
-- disconnected account, a top-up), which lets the same crossing alert again.
-- The insert is what sends the email: a trigger hands the row to the
-- notifications edge function.
create table billing.alerts (
  organization_id uuid not null,
  product_id text not null,
  interval text not null,
  period date not null,
  level text not null,
  -- The figures at the crossing, as the email states them.
  quantity numeric not null,
  cap numeric not null,
  created_at timestamp with time zone default now() not null
);

alter table only billing.alerts
add constraint alerts_pkey
primary key (organization_id, product_id, interval, period, level);

alter table only billing.alerts
add constraint alerts_usage_fkey
foreign key (organization_id, product_id, interval, period)
references billing.usage(organization_id, product_id, interval, period)
on delete cascade;

alter table only billing.alerts
add constraint alerts_level_check
check (level in ('near', 'capped'));
