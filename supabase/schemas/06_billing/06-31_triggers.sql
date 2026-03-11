-- Initialize subscription on organization creation
create trigger initialize_billing_subscription
after insert
on public.organizations
for each row
execute function billing.initialize_subscription();

-- Check billing limit before message insert
-- Named to sort before "handle_new_message" (alphabetical trigger execution)
create trigger check_billing_message_limit
before insert
on public.messages
for each row
execute function billing.check_product_limit();

-- Update message usage after insert or delete
create trigger update_billing_message_usage
after insert or delete
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

-- Update usage after ledger entry
create trigger update_billing_ledger_usage
after insert
on billing.ledger
for each row
execute function billing.process_ledger_entry();
