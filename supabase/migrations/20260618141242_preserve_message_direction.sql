-- direction is set once at insert and never changes. Upserts (onConflict
-- external_id) carry a direction in the incoming row, so without this an
-- echo/status row could flip an existing message's direction — e.g. an
-- Instagram self-message echo (recorded as incoming) landing on the outgoing
-- row we already sent. A BEFORE UPDATE trigger pins direction to its original
-- value; updates only ever merge content/status.
set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.preserve_message_direction()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.direction := old.direction;
  return new;
end;
$function$
;

CREATE TRIGGER preserve_direction BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.preserve_message_direction();
