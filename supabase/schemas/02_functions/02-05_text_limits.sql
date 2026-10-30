-- The longest text a service sends in one message, in characters: a text
-- message's text (type 'text') or a file's caption (type 'file'). Null where
-- the service sets none we enforce (local, discord, teams), and for data
-- parts, whose text is not what is sent.
--
-- Instagram and TikTok attachments have no caption, so their dispatchers send
-- it as a text after the file, and it takes the text limit. Slack truncates
-- past its limit rather than refusing.
--
-- Clients ask it to split what they write; the limit_text_length trigger holds
-- every outgoing row to it.
create function public.text_limit(service public.service, type text)
returns integer
language sql
immutable
set search_path to ''
as $$
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
$$;

-- What is dispatched is the row as written, never a cut or a split of it: a
-- text longer than its service sends is refused here, at insert, where the
-- writer can still split it, rather than failing at dispatch.
create function public.limit_text_length() returns trigger
language plpgsql
set search_path to ''
as $$
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
$$;
