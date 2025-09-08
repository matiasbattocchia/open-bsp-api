CREATE TRIGGER handle_message_to_annotator AFTER INSERT ON public.messages FOR EACH ROW WHEN ((((new.direction = 'outgoing'::direction) OR (new.direction = 'incoming'::direction)) AND ((new.status ->> 'pending'::text) IS NOT NULL) AND (((new.message ->> 'media'::text) IS NOT NULL) OR ((new.message ->> 'type'::text) = 'file'::text)))) EXECUTE FUNCTION edge_function('/annotator', 'post');


