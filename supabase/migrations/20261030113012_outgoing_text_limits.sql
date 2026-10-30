set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.limit_text_length()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  _limit integer := public.text_limit(new.service, new.content->>'type');
  _length integer := char_length(new.content->>'text');
begin
  if _length > _limit then
    raise exception using
      errcode = 'check_violation',
      message = format(
        '%s is %s characters long; %s sends at most %s',
        case new.content->>'type' when 'file' then 'The caption' else 'The text' end,
        _length, new.service, _limit
      ),
      hint = 'Split it into several messages.';
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.text_limit(service public.service, type text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when type not in ('text', 'file') then null
    else case service
      when 'whatsapp' then case type when 'file' then 1024 else 4096 end
      when 'instagram' then 1000
      when 'tiktok' then 6000
      when 'slack' then 40000
      when 'whatsapp-web' then 65536
    end
  end;
$function$
;

CREATE TRIGGER limit_text_length BEFORE INSERT ON public.messages FOR EACH ROW WHEN (((new.sender_address IS NULL) AND ((new.status ->> 'pending'::text) IS NOT NULL) AND ((new.content ->> 'internal'::text) IS NULL) AND ((new.content ->> 'text'::text) IS NOT NULL))) EXECUTE FUNCTION public.limit_text_length();


