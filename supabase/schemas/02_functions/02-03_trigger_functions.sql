-- Create local address and owner agent after org creation
create function public.after_insert_on_organizations() returns trigger
language plpgsql
security definer -- bypass RLS to create the first owner
set search_path to ''
as $$
declare
  user_id uuid := auth.uid();
  user_name text;
begin
  insert into public.organizations_addresses (organization_id, service, address)
    values (new.id, 'local', new.id::text);

  if user_id is not null then
    select coalesce(raw_user_meta_data->>'full_name', email, '?') into user_name
    from auth.users
    where id = user_id;

    insert into public.agents (organization_id, user_id, name, role)
    values (new.id, user_id, user_name, 'owner');
  end if;

  return new;
end;
$$;

-- A conversation's identity is its addressing, so none of it ever changes:
-- not the peer address, not the account (organization_address, service) the
-- conversation hangs off. Nothing legitimate needs it to: an ingestor upserts
-- on the identity index, and `local` mints the address at creation. Anything
-- that could move the address could also point a room it owns at two
-- colleagues' canonical roster, and make the DM between them impossible — the
-- identity index would already be taken. Freezing the account columns is also
-- what makes messages' insert-time addressing validation a permanent truth:
-- the parent can never drift out from under its rows.
--
-- `type` is immutable to API roles for a sharper reason: retyping a private
-- `direct` as `channel` publishes everyone else's messages to the whole
-- organization, and any one participant could do it with no role to stop them.
-- The service role keeps the write, because Slack really does convert a
-- private channel to a public one and the sync must follow.
--
-- RLS cannot express either: an UPDATE policy sees the old row in USING and
-- the new row in WITH CHECK, never both, so "this column may not change" has
-- to be a trigger. Same reason preserve_message_addressing exists.
create function public.preserve_conversation_addressing() returns trigger
language plpgsql
as $$
begin
  new.organization_id := old.organization_id;
  new.address := old.address;
  new.organization_address := old.organization_address;
  new.service := old.service;

  if current_role not in ('service_role', 'postgres', 'supabase_admin') then
    new.type := old.type;
  end if;

  return new;
end;
$$;

-- A deletion the deleted can undo is not a deletion. `members can update
-- themselves` is keyed on user_id = auth.uid() alone, so a removed member
-- reaches their own row and could otherwise clear deleted_at and restore every
-- access it revoked.
create function public.preserve_agent_deletion() returns trigger
language plpgsql
as $$
begin
  if current_role not in ('service_role', 'postgres', 'supabase_admin') then
    new.deleted_at := old.deleted_at;
  end if;

  return new;
end;
$$;

-- Prevent deletion of the last owner in an organization
create function public.prevent_last_owner_deletion() returns trigger
language plpgsql
set search_path to ''
as $$
declare
  owner_count int;
begin
  -- Skip check if org is being deleted (cascade delete)
  if not exists (
    select 1 from public.organizations
    where id = old.organization_id
    for update skip locked
  ) then
    return old;
  end if;

  if old.role = 'owner' then
    -- An agents row IS a member (invitations are their own table), and an
    -- owner is a person: `user_id is not null`.
    select count(*) into owner_count
    from public.agents
    where organization_id = old.organization_id
      and role = 'owner'
      and user_id is not null
      and deleted_at is null
      and id <> old.id;

    if owner_count = 0 then
      raise exception 'Cannot delete the last owner of an organization';
    end if;
  end if;

  return old;
end;
$$;

-- The other end of the same rule. agents_user_id_fkey is `on delete set null`,
-- so erasing an auth user leaves their agent rows standing but unclaimed —
-- and an unclaimed row stops counting as an owner, which can quietly leave an
-- organization with none. Guarding the agents table cannot catch it: nothing
-- is deleted there, a column is merely nulled.
--
-- So the refusal belongs here. An owner has to hand the organization over,
-- leave it, or delete it before their account can go. There is no account
-- deletion flow in the product today; this exists so that whichever one gets
-- built — including a click in the Supabase dashboard — cannot take an
-- organization down with it.
create function public.prevent_owner_user_deletion() returns trigger
language plpgsql
security definer -- bypass RLS: no policy applies to a user being erased
set search_path to ''
as $$
declare
  owned int;
begin
  select count(*) into owned
  from public.agents
  where user_id = old.id
    and role = 'owner'
    and deleted_at is null;

  if owned > 0 then
    raise exception 'Cannot delete a user who still owns % organization(s)', owned
      using hint = 'transfer ownership, leave, or delete the organization first';
  end if;

  return old;
end;
$$;

-- Deleting an agent marks the row instead of removing it, for every agent —
-- hence its own trigger rather than a branch in the owner guard above, whose
-- WHEN clause narrows it to human owners.
--
-- An agent is referenced by things that outlive their membership: message
-- authorship, and — since local conversations are identified by their roster —
-- the very ADDRESS of every direct they are in. Removing the row
-- cascades away their participation while the address goes on naming them,
-- leaving a conversation that can never be repaired and a roster slot occupied
-- forever.
--
-- SECURITY DEFINER for two reasons: the caller has no UPDATE on someone else's
-- agent row, and preserve_agent_deletion would restore the old deleted_at for
-- any non-privileged role — including the member deleting themselves.
--
-- The same organizations probe as above: during an organization cascade the
-- parent row is locked, SKIP LOCKED finds nothing, and the delete is allowed
-- through — otherwise a suppressed cascade would leave the FK unsatisfiable
-- and the organization undeletable.
create function public.mark_agent_deleted() returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not exists (
    select 1 from public.organizations
    where id = old.organization_id
    for update skip locked
  ) then
    return old;
  end if;

  update public.agents
  set deleted_at = coalesce(deleted_at, now())
  where id = old.id;

  return null;
end;
$$;

-- SECURITY DEFINER because this is now the ONLY way a conversation gets
-- created for a mirror service: 05-03 grants INSERT on conversations to API
-- roles for `local` alone, so a member starting a WhatsApp chat does it by
-- inserting the first message and letting this trigger mint the row. The
-- elevation cannot be used to reach a conversation the caller may not see —
-- the messages WITH CHECK policy runs after BEFORE triggers, so it re-tests
-- visibility against the conversation_id this function just resolved.
create function public.before_insert_on_messages() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  _conv record;
begin
  -- The addressing, in two columns:
  --
  -- sender_address is a contact reference or null: the peer who authored the
  -- message (a phone/BSUID, a Slack workspace member — ties to
  -- contacts_addresses), or null when the account itself spoke. Deliverable
  -- vs record-only is decided by status.pending + content.internal, not by
  -- authorship (see the dispatch trigger).
  -- conversation_address is the peer the conversation is with.

  -- Internal rows (tool traces, agent errors) are record-only and are born
  -- unarmed by their writer: agent-client — the one client that writes them —
  -- inserts them with status {}. pending is the declared arm bit, and not
  -- carrying it is also how history-synced rows pass through without waking
  -- any automation.

  -- If conversation_id is stated, the conversation is the authority on the
  -- denormalized addressing: fill what the writer omitted, refuse what they
  -- misstated. These columns are load-bearing at dispatch time — the peer
  -- address is the recipient, organization_address picks the account and its
  -- token, service picks the dispatcher — so drift here is a message to the
  -- wrong place. Together with the update-time freezes (both preserve_*
  -- triggers) this gives the composite-FK guarantee for one PK lookup,
  -- without widening the messages indexes to a four-column text key.
  if new.conversation_id is not null then
    select c.organization_id, c.service, c.organization_address, c.address
    into _conv
    from public.conversations c
    where c.id = new.conversation_id;

    if not found then
      raise exception 'Conversation % does not exist', new.conversation_id;
    end if;

    if new.organization_id is null then
      new.organization_id := _conv.organization_id;
    elsif new.organization_id <> _conv.organization_id then
      raise exception 'organization_id % disagrees with the conversation''s %',
        new.organization_id, _conv.organization_id;
    end if;

    if new.service is null then
      new.service := _conv.service;
    elsif new.service <> _conv.service then
      raise exception 'service % disagrees with the conversation''s %',
        new.service, _conv.service;
    end if;

    if new.organization_address is null then
      new.organization_address := _conv.organization_address;
    elsif new.organization_address <> _conv.organization_address then
      raise exception 'organization_address % disagrees with the conversation''s %',
        new.organization_address, _conv.organization_address;
    end if;

    if new.conversation_address is null then
      new.conversation_address := _conv.address;
    elsif new.conversation_address <> _conv.address then
      raise exception 'conversation_address % disagrees with the conversation''s %',
        new.conversation_address, _conv.address;
    end if;

    return new;
  end if;

  -- Look up conversation_id. A conversation IS a channel, so this is an exact
  -- hit on conversations_identity_idx — the key is unique, no most-recent
  -- tiebreak.
  --
  -- organization_id is in the predicate so the scan can start from the index's
  -- leading column. Plain equality throughout: conversation_address is never
  -- null here, and equality (unlike `is not distinct from`) is indexable.
  --
  -- A peerless (local) message with neither conversation_id nor
  -- conversation_address matches nothing and falls through to the insert
  -- below, where the conversations trigger mints an id for it.
  if new.conversation_address is not null then
    select id into new.conversation_id
    from public.conversations
    where organization_id = new.organization_id
      and service = new.service
      and organization_address = new.organization_address
      and address = new.conversation_address;
  end if;

  -- Create conversation if it doesn't exist. Two messages for a peer nobody
  -- has spoken to yet can arrive at once — a webhook batch, or two batches in
  -- flight — and both find nothing above, so the insert has to survive losing
  -- that race rather than raise on conversations_identity_idx. `do nothing`
  -- returns no row when the other writer won; read its id back instead.
  --
  -- A peerless (local) conversation_address is null, which is distinct from
  -- itself in a unique index, so that path never conflicts and always mints.
  if new.conversation_id is null then
    insert into public.conversations (
      organization_id,
      organization_address,
      address,
      service
    ) values (
      new.organization_id,
      new.organization_address,
      new.conversation_address,
      new.service
    )
    on conflict (organization_id, organization_address, service, address)
    do nothing
    returning id into new.conversation_id;

    if new.conversation_id is null then
      select id into new.conversation_id
      from public.conversations
      where organization_id = new.organization_id
        and service = new.service
        and organization_address = new.organization_address
        and address = new.conversation_address;
    end if;
  end if;

  return new;
end;
$$;

-- BEFORE UPDATE: a message's addressing is set at insert — where
-- before_insert_on_messages validates it against the conversation — and never
-- changes: not the conversation reference, not the denormalized account and
-- peer columns it was validated with. sender_address may be FILLED (null →
-- the actual author) but never flipped — the Slack echo of a send from
-- OpenBSP updates the dispatched row (sender null) with the member who sent
-- it, while an Instagram self-message echo landing on an already-attributed
-- row cannot rewrite it. Updates otherwise only merge content/status.
create function public.preserve_message_addressing() returns trigger
language plpgsql
as $$
begin
  new.sender_address := coalesce(old.sender_address, new.sender_address);
  new.organization_id := old.organization_id;
  new.conversation_id := old.conversation_id;
  new.conversation_address := old.conversation_address;
  new.organization_address := old.organization_address;
  new.service := old.service;

  return new;
end;
$$;

-- BEFORE UPDATE, ahead of the content merge: a medium and its placeholder can
-- land on the same row in either order — the Cloud API's history sync replays
-- a media message as a media_placeholder and sends the asset on its own, and
-- whichever arrives second patches the first. A stored file always wins. A
-- placeholder landing on a row that holds a file leaves the content as it is
-- (the caption is the same on both); a file landing on a placeholder drops the
-- placeholder's `data`, which a FilePart does not carry.
create function public.keep_stored_media() returns trigger
language plpgsql
as $$
begin
  if new.content->>'kind' = 'media_placeholder'
    and old.content->'file'->>'uri' is not null then
    new.content := old.content;
  elsif new.content->>'type' = 'file' and old.content ? 'data' then
    new.content := new.content || '{"data": null}'::jsonb;
  end if;

  return new;
end;
$$;

-- AFTER trigger: a synced REMOVE dropped the entry from the service's address
-- book — delete the row too, unless a conversation still references the
-- address. The conversation's address equals the contact's exactly on direct
-- chats — the only shape a contact entry describes.
create function public.cleanup_removed_address_if_empty() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.conversations c
    where c.organization_id = new.organization_id
      and c.organization_address = new.organization_address
      and c.service = new.service
      and c.address = new.address
  ) then
    delete from public.contacts_addresses
    where organization_id = new.organization_id
      and organization_address = new.organization_address
      and service = new.service
      and address = new.address;
  end if;

  return null;
end;
$$;

-- Writes the participants of a `local` conversation.
--
-- `local` is the one service where a member creates the conversation directly
-- (05-03 grants INSERT for it alone), and the one whose visibility is decided
-- purely by shape: a `channel` is org-wide, everything else is participants
-- only. So without these rows the member who just created a conversation could
-- not see it.
--
-- Where the participants come from depends on the shape, and it is the same
-- split as the address (before_insert_on_conversations):
--
--   direct          The roster IS the identity, so it is read straight back
--                   out of the canonical address — which is why a direct is
--                   always roster-addressed, including a note to self. Fixed
--                   here, for good: 05-12 grants no member insert or delete
--                   for it, because changing who is in one would make it a
--                   different conversation.
--   group, channel  Membership is mutable and starts with the creator alone;
--                   everyone else arrives through 05-12.
--
-- SECURITY DEFINER: conversations_agents is service-managed for the shapes
-- that matter (05-12), so the caller has no INSERT of their own here. A
-- service-role or API-key insert has no auth.uid() and so no creator to
-- record — for group/channel that yields a conversation nobody is in (see
-- TODO).
create function public.after_insert_on_local_conversation() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.conversations_agents (
    organization_id,
    service,
    organization_address,
    conversation_id,
    agent_id
  )
  select
    new.organization_id,
    new.service,
    new.organization_address,
    new.id,
    a.id
  from public.agents a
  where a.organization_id = new.organization_id
    and case
      when new.type = 'direct'
      then a.id::text = any (string_to_array(new.address, ':'))
      else a.user_id = auth.uid()
    end
  on conflict do nothing;

  return new;
end;
$$;

create function public.before_insert_on_conversations() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  _declared text[];
  _unknown text[];
  _roster uuid[];
  _caller uuid;
begin
  -- `local` addresses itself, in one of two ways, and the client chooses by
  -- stating a type:
  --
  --   group / channel   A named container whose membership changes. Identity
  --                     is its own; it gets the row's id, further down.
  --   anything else     A ROSTER. The client says who is in it ('A:B:C', any
  --                     order) and this canonicalises to sorted agent ids.
  --                     That canonical form IS the identity, so the unique
  --                     index answers "does this conversation already exist
  --                     between these people" with a conflict — a pair and a
  --                     party of eight are the same shape: `direct`.
  --
  -- The author is always in the room they open, so it is added rather than
  -- demanded: you cannot start a conversation you are not in, and omitting the
  -- address entirely is then just a roster of one — a note to self, which is
  -- what the UI's "new conversation" has always produced. One of those per
  -- member, for the same reason there is one DM per pair.
  if new.service = 'local'
    and (new.type is null or new.type = 'direct')
  then
    -- Null for the service role, which has no agent of its own; a roster it
    -- states is taken as given.
    select a.id into _caller
    from public.agents a
    where a.organization_id = new.organization_id
      and a.user_id = auth.uid();

    _declared := array_remove(
      coalesce(string_to_array(new.address, ':'), '{}'), ''
    );

    if _caller is not null then
      _declared := _declared || _caller::text;
    end if;

    -- Named before resolved, so the error can say WHICH id failed. Every
    -- malformed roster arrives here: a stranger's id, an agent of another
    -- organization, an uppercased uuid (agent ids render lowercase), a word
    -- that is not a uuid at all.
    _unknown := array(
      select distinct d
      from unnest(_declared) d
      where not exists (
        select 1 from public.agents a
        where a.organization_id = new.organization_id and a.id::text = d
      )
    );

    if array_length(_unknown, 1) is not null then
      raise exception 'Roster names %, not an agent of this organization',
        array_to_string(_unknown, ', ');
    end if;

    -- distinct: naming someone twice is a typo, not a bigger room.
    select array_agg(distinct a.id order by a.id) into _roster
    from public.agents a
    where a.organization_id = new.organization_id
      and a.id::text = any (_declared);

    if _roster is not null then
      new.address := array_to_string(_roster, ':');
      new.type := 'direct';
    end if;
  end if;

  -- A named container is identified by ITSELF, so its address is not the
  -- client's to choose. A supplied address could name the canonical roster of
  -- two other people — a `group` addressed 'B:C' would occupy the identity
  -- index and make the DM between B and C impossible forever, while neither
  -- could see or delete the row holding it.
  if new.service = 'local' and new.type in ('group', 'channel') then
    new.address := new.id::text;
  end if;

  -- A conversation minted without a stated shape is 1:1 — that is what an
  -- inbound message from an unknown peer means, and it is the only shape
  -- WhatsApp Cloud and Instagram have. Connectors that know better state it
  -- before the message lands (generic-webhook, for whatsapp-web group JIDs and
  -- broadcast lists).
  --
  -- `slack` is exempt: its ingestor classifies asynchronously and relies on a
  -- null meaning "ask conversations.info again", which a default would erase.
  if new.type is null and new.service <> 'slack' then
    new.type := 'direct';
  end if;

  -- Conversations with external services must have a peer.
  if new.service <> 'local' and new.address is null then
    raise exception 'Conversations with external services require an address';
  end if;

  -- A `local` group or channel is identified by itself, not by who is in it,
  -- so it addresses itself: the conversation's own id. Column defaults are
  -- applied before BEFORE-INSERT triggers run, so new.id is already there.
  -- Keeping the column NOT NULL is what lets the identity index be a plain
  -- unique constraint rather than one whose behaviour depends on NULL
  -- semantics.
  if new.address is null then
    new.address := new.id::text;
  end if;

  -- No contact bootstrap: writers manage contacts_addresses themselves
  -- (the address is a soft reference by design).
  return new;
end;
$$;

-- The invitee is the one row shape in the schema that reads a table it has no
-- access to: 05-13 hands them their own pending invitations and nothing else,
-- while organizations (05-00) and agents (05-04) are member-only — they are
-- not a member yet, that being the point. So the banner can name an email and
-- a role, and cannot say WHICH organization or WHO asked.
--
-- These three columns answer that without opening either table. They are a
-- snapshot of what the offer says, and the writer has no say in them: any
-- stated value is discarded and replaced with the authority's. Insert AND
-- update, because the invitee has no way to check the text — a writer-stated
-- name would be a phishing field ("join Acme Payroll") rather than a
-- denormal, and re-deriving on every write is what makes restating one
-- pointless. It also carries a rename through to offers still open.
--
-- SECURITY DEFINER for the email: auth.users is granted to no API role.
create function public.before_insert_or_update_on_invitations() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select o.name into new.organization_name
  from public.organizations o
  where o.id = new.organization_id;

  -- Scoped to the invitation's own organization: invitations_invited_by_fkey
  -- points at agents(id) alone, so nothing stops an owner from naming an
  -- agent in someone else's tenant, and copying that name here would be the
  -- one place it becomes readable. A mismatch leaves both columns null —
  -- `select into` assigns null when no row is found.
  select a.name, u.email
  into new.invited_by_name, new.invited_by_email
  from public.agents a
  left join auth.users u on u.id = a.user_id
  where a.id = new.invited_by
    and a.organization_id = new.organization_id;

  return new;
end;
$$;

create function public.notify_webhook() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  webhook_record record;
  headers jsonb;
begin
  -- loop through all matching webhooks
  for webhook_record in
    select w.url, w.token
    from public.webhooks w
    where new.organization_id = w.organization_id
      and w.table_name = tg_table_name::public.webhook_table
      and lower(tg_op)::public.webhook_operation = any(w.operations)
    limit 3
  loop
    -- prepare headers
    headers := case
      when webhook_record.token is not null then
        jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || webhook_record.token
        )
      else
        jsonb_build_object(
          'content-type', 'application/json'
        )
      end;

    -- send webhook notification
    perform net.http_post(
      url := webhook_record.url,
      body := jsonb_build_object(
        'data', to_jsonb(new),
        'entity', tg_table_name,
        'action', lower(tg_op)
      ),
      headers := headers
    );
  end loop;

  return new;
end;
$$;
