-- organization_id is useful for realtime.
create table public.messages (
  organization_id uuid not null,
  conversation_id uuid not null,
  id uuid default gen_random_uuid() not null,
  external_id text,
  agent_id uuid, -- internal sender (should be not null for internal and outgoing)
  -- denormalized properties
  service public.service not null,
  organization_address text not null,
  -- Logical partition of a conversation (Slack/Discord-style threads): the
  -- external_id of the thread's root message, shared by the root (which points
  -- to itself) and all of its replies. null = top-level / main channel
  -- timeline. Soft reference like content.re_message_id — not a FK, so it
  -- tolerates out-of-order arrival and out-of-window roots.
  thread_id text,
  -- Unified peer addressing:
  -- conversation_address — the peer the conversation is with (individual or
  --   group/channel). Soft reference, like thread_id.
  -- sender_address — the CONTACT who authored the message (a WhatsApp
  --   phone/BSUID, a Slack workspace member — ties to contacts_addresses,
  --   soft reference), or null when the account itself spoke (UI/AI sends,
  --   echoes, history, tool traces). Deliverability is NOT an authorship
  --   question: the dispatch trigger arms on status.pending plus not being
  --   record-only (content.internal). Fill-once: a Slack echo fills null
  --   with the member who actually sent; a non-null sender is immutable.
  conversation_address text,
  sender_address text,
  ----
  content jsonb not null,
  status jsonb default jsonb_build_object('pending', now()) not null,
  timestamp timestamp with time zone default now() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table only public.messages
add constraint messages_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

alter table only public.messages
add constraint messages_conversation_id_fkey
foreign key (conversation_id)
references public.conversations(id)
on delete cascade;

alter table only public.messages
add constraint messages_agent_id_fkey
foreign key (agent_id)
references public.agents(id)
on delete set null;

alter table only public.messages
add constraint messages_pkey primary key (id);

alter table only public.messages
add constraint messages_external_id_key unique (external_id);

-- Declared NOT VALID (not inline) to match the deployed state. ~46k legacy
-- messages predate the v1 content schema (no version/kind) and were never
-- checked, so the constraint cannot be validated; it still enforces the shape
-- for every new row. Declaring NOT VALID here keeps `supabase db diff` from
-- re-emitting a drop/re-add on every run. See migration
-- 20260424132025_fix_messages_content_schema_allow_empty.
alter table only public.messages
add constraint messages_content_schema check (
  content = '{}'::jsonb -- status-only upserts (content merged later)
  or (
    content->>'version' is not null
    and content->>'type' in ('text', 'file', 'data')
    and content->>'kind' is not null
  )
) not valid;

-- No plain (organization_id) index: messages_org_conv_timestamp_idx below
-- leads with that column, so it serves the organization cascade too.

-- Needed on its own even though the composite below mentions the column: that
-- one leads with organization_id, so it cannot answer a conversation-only
-- probe — which is what the cascade from conversations runs.
create index messages_conversation_id_idx
on public.messages
using btree (conversation_id);

-- Serves the two per-minute sweeps (dispatch-outgoing-pending-messages,
-- preprocess-pending-messages), which scan a rolling 12-hour window by
-- timestamp. 728k scans, and the reason this index is not merely the
-- less-used sibling of created_at below.
create index messages_timestamp_idx
on public.messages
using btree (timestamp);

-- Incremental polling by API clients: `where service = ? and created_at >= ?
-- order by created_at desc`. Unindexed, that was the single most expensive
-- statement in production — 10,608 calls, 174 ms mean, ~86 GB read from disk —
-- because nothing indexed created_at at all and every call sorted the table.
create index messages_service_created_at_idx
on public.messages
using btree (service, created_at desc);

create index messages_updated_at_idx
on public.messages
using btree (updated_at);

create index messages_org_conv_timestamp_idx
on public.messages
using btree (organization_id, conversation_id, timestamp desc);

-- Media-object → referencing-message lookup (is_media_visible, used by the
-- storage.objects download policy). v1 file parts only: v0 legacy media is
-- not matched, so it stays org-scoped like any unreferenced object.
create index messages_file_uri_idx
on public.messages
using btree ((content->'file'->>'uri'))
where content->'file'->>'uri' is not null;

create trigger handle_new_message
before insert
on public.messages
for each row
execute function public.before_insert_on_messages();

-- Team chat is excluded here rather than left to agent-client, which refuses
-- it anyway: a mirrored workspace can be thousands of messages a day, and
-- every one of them would spend an invocation to be told no. `local` cannot
-- arm this trigger at all (a colleague is not a contact, so sender_address is
-- null), but it is named for the same reason discord and teams are not —
-- saying what the rule is beats relying on why it cannot happen.
create trigger handle_incoming_message_to_agent
after insert
on public.messages
for each row
when (
  new.sender_address is not null
  and new.service not in ('local'::public.service, 'slack'::public.service)
  and (new.status ->> 'pending') is not null
)
execute function public.edge_function('/agent-client', 'post');

-- The internal mirror of the trigger above: `agent_id` is authorship in
-- member space the way `sender_address` is in contact space. Only `local`
-- and only armed rows; whether the room actually IS an AI DM is the
-- function's question — a WHEN clause cannot look inside the address. The
-- internal clause mirrors the dispatch trigger's: writers insert record-only
-- rows unarmed, but an AI waking up to a tool trace should not depend on
-- writer discipline either.
create trigger handle_local_message_to_agent
after insert
on public.messages
for each row
when (
  new.agent_id is not null
  and new.service = 'local'::public.service
  and (new.status ->> 'pending') is not null
  and new.content ->> 'internal' is null
)
execute function public.local_message_to_agent();

-- Team chat is excluded, and `local` was never the whole of it: reading a
-- colleague's message is not a receipt owed to anyone outside, and on Slack
-- there is no user-token API to deliver one with. It also matters now that
-- Slack rows carry status.pending like every other inbound message — without
-- this, every read would POST to slack-dispatcher for nothing.
--
-- Internal comms have a second, unanswered question anyway: a read is by ONE
-- of several members, so "the message was read" is not a fact about the
-- conversation. See TODO.
create trigger handle_mark_as_read_to_dispatcher
after update
on public.messages
for each row
when (
  new.sender_address is not null
  and new.service not in ('local'::public.service, 'slack'::public.service)
  and (
    (old.status ->> 'read') <> (new.status ->> 'read')
    or (old.status ->> 'typing') <> (new.status ->> 'typing')
  )
  and (new.status ->> 'pending') is not null
)
execute function public.dispatcher_edge_function();

-- Sendability is three facts: the account authored the row (sender null),
-- it is armed (pending — scheduled sends wait for their timestamp), and it
-- is not record-only (content.internal, the writer-declared marker on tool
-- traces, agent errors, internal notes). There is deliberately no kind
-- filter: a kind no service can encode should not be inserted armed, and a
-- writer that does gets a loud `failed` stamp from the dispatcher instead
-- of a silent no-op here.
create trigger handle_outgoing_message_to_dispatcher
after insert
on public.messages
for each row
when (
  new.sender_address is null
  and new.timestamp <= now()
  and (new.status ->> 'pending') is not null
  and new.content ->> 'internal' is null
)
execute function public.dispatcher_edge_function();

create trigger handle_message_to_media_preprocessor
after insert
on public.messages
for each row
when (
  (new.status ->> 'pending') is not null
  and (new.content ->> 'type') = 'file'
)
execute function public.edge_function('/media-preprocessor', 'post');

create trigger z_notify_webhook_messages
after insert or update
on public.messages
for each row
execute function public.notify_webhook();

-- Named to sort before set_message: BEFORE triggers fire alphabetically, and
-- this one decides what the merge receives.
create trigger keep_stored_media
before update
on public.messages
for each row
when (
  new.content ->> 'kind' = 'media_placeholder'
  or new.content ->> 'type' = 'file'
)
execute function public.keep_stored_media();

-- Addressing is set (and validated against the conversation) at insert and
-- frozen here; updates only fill sender_address once and merge content/status.
create trigger preserve_addressing
before update
on public.messages
for each row
execute function public.preserve_message_addressing();

create trigger set_message
before update
on public.messages
for each row
when (
  new.content is not null
)
execute function public.merge_update('content');

create trigger set_status
before update
on public.messages
for each row
when (
  new.status is not null
)
execute function public.merge_update('status');

create trigger set_updated_at
before update
on public.messages
for each row
execute function public.moddatetime('updated_at');
