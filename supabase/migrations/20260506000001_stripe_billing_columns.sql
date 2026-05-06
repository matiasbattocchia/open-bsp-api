-- ============================================================================
-- Stripe integration — add Stripe IDs to subscriptions
-- ============================================================================

alter table billing.subscriptions
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;

create index if not exists idx_subscriptions_stripe_customer
  on billing.subscriptions(stripe_customer_id);

create index if not exists idx_subscriptions_stripe_subscription
  on billing.subscriptions(stripe_subscription_id);
