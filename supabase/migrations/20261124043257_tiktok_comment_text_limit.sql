set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.limit_text_length()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  _type text := case new.content->>'kind'
    when 'comment' then 'comment'
    else new.content->>'type'
  end;
  _limit integer := public.text_limit(new.service, _type);
  _length integer := char_length(new.content->>'text');
begin
  if _length > _limit then
    raise exception using
      errcode = 'check_violation',
      message = format(
        '%s is %s characters long; %s sends at most %s',
        case _type
          when 'file' then 'The caption'
          when 'comment' then 'The comment'
          else 'The text'
        end,
        _length, new.service, _limit
      ),
      hint = case _type
        when 'comment' then 'Shorten it: a comment goes out whole.'
        else 'Split it into several messages.'
      end;
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
    when type = 'comment' then case service when 'tiktok' then 1200 end
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


