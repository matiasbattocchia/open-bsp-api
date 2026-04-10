drop trigger if exists "check_billing_message_limit" on "public"."messages";

drop trigger if exists "update_billing_message_usage" on "public"."messages";

CREATE TRIGGER update_billing_message_usage_on_delete AFTER DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION billing.update_product_usage();

CREATE TRIGGER check_billing_message_limit BEFORE INSERT ON public.messages FOR EACH ROW WHEN ((new."timestamp" >= (now() - '00:00:10'::interval))) EXECUTE FUNCTION billing.check_product_limit();

CREATE TRIGGER update_billing_message_usage AFTER INSERT ON public.messages FOR EACH ROW WHEN ((new."timestamp" >= (now() - '00:00:10'::interval))) EXECUTE FUNCTION billing.update_product_usage();


