-- Initialize subscription on organization creation
create trigger initialize_billing_subscription
after insert
on public.organizations
for each row
execute function billing.initialize_subscription();

-- Check billing limit before message insert
-- Named to sort before "handle_new_message" (alphabetical trigger execution)
--
-- Only sendable rows are capped — the same three facts that arm
-- handle_outgoing_message_to_dispatcher (account-authored, pending, not
-- record-only). Inbound is what the org's CONTACTS sent: blocking it loses
-- data and 500s the shared Meta webhook, so it never trips the cap (usage
-- still counts it). The status conditions also exempt receipt merges and
-- history/echo imports, which carry an explicit final status.
create trigger check_billing_message_limit
before insert
on public.messages
for each row
when (
  new.sender_address is null
  and (new.status ->> 'pending') is not null
  and new.content ->> 'internal' is null
)
execute function billing.check_product_limit();

-- Update message usage after insert (only recent, excludes history sync)
create trigger update_billing_message_usage
after insert
on public.messages
for each row
when (new.timestamp >= now() - interval '10 seconds')
execute function billing.update_product_usage();

-- Update message usage after delete (always, to keep counters accurate)
create trigger update_billing_message_usage_on_delete
after delete
on public.messages
for each row
execute function billing.update_product_usage();

-- Check billing limit before conversation insert
create trigger check_billing_conversation_limit
before insert
on public.conversations
for each row
execute function billing.check_product_limit();

-- Update conversation usage after insert or delete
create trigger update_billing_conversation_usage
after insert or delete
on public.conversations
for each row
execute function billing.update_product_usage();

-- Check billing limit before storage upload
create trigger check_billing_storage_limit
before insert
on storage.objects
for each row
execute function billing.check_storage_limit();

-- Update storage usage after upload or delete
create trigger update_billing_storage_usage
after insert or delete
on storage.objects
for each row
execute function billing.update_storage_usage();

-- Track connected accounts (and check the cap for new ones)
create trigger update_billing_account_usage
after insert or update of status or delete
on public.organizations_addresses
for each row
execute function billing.update_account_usage();

-- Skip ledger insert if product doesn't exist (no billing)
-- Named "a_guard" to sort before "update_billing" (alphabetical trigger execution)
create trigger a_guard_billing_ledger_product
before insert
on billing.ledger
for each row
execute function billing.guard_ledger_insert();

-- Update usage after ledger entry
create trigger update_billing_ledger_usage
after insert
on billing.ledger
for each row
execute function billing.process_ledger_entry();
