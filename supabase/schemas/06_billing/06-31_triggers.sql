-- Check billing limit before message insert
-- Named to sort before "handle_new_message" (alphabetical trigger execution)
create trigger check_billing_message_limit
before insert
on public.messages
for each row
execute function billing.check_message_limit();

-- Increment usage counters after message insert
create trigger increment_billing_message_usage
after insert
on public.messages
for each row
execute function billing.increment_message_usage();

-- Check billing limit before conversation insert
create trigger check_billing_conversation_limit
before insert
on public.conversations
for each row
execute function billing.check_conversation_limit();

-- Increment usage counters after conversation insert
create trigger increment_billing_conversation_usage
after insert
on public.conversations
for each row
execute function billing.increment_conversation_usage();

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
