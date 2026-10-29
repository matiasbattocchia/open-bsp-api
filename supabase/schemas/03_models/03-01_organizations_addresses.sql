create table public.organizations_addresses (
  organization_id uuid not null,
  service public.service not null,
  address text not null,
  -- Owner of a personal account (e.g. a member's Slack identity). null =
  -- ownerless: for customer-facing services that means org-wide (the shared
  -- inbox); for intra-org services (slack) nothing is ever org-wide — the
  -- ownerless workspace anchor's conversations are visible to their
  -- members only (see is_conversation_visible). The FK to agents is declared
  -- in 03-04_agents.sql because agents is created after this table.
  agent_id uuid,
  extra jsonb,
  status text default 'connected'::text not null,
  -- What the service broke, when it was the service and not a member: the UI
  -- warns, and whoever can reconnect the account gets an email. null while
  -- the account works, and after a member disconnects it themselves.
  -- { reason, until?: ISO, detail?: text } — reason is one of:
  --   logged_out  WhatsApp unlinked the device (WhatsApp Web)
  --   banned      the number or account was barred; a ban that says when it
  --               lifts carries `until`
  --   expired     the token died
  --   removed     our access was taken away at the provider (unshared, app
  --               uninstalled, deauthorized)
  --   offboarded  a coexistence number stopped sharing with the API
  --   deleted     the number or its account no longer exists
  --   violation   Meta reported a policy violation
  --   restricted  Meta limited what the account may do for a while
  --               (`until`), e.g. starting conversations
  --   locked      Meta refused to send because the account is locked
  -- `detail` is the provider's own word for it, e.g. a violation's type
  -- (SCAM). Usually on a disconnected row; a token that died, a restriction
  -- and a lock keep theirs connected, since messages still arrive and the
  -- account keeps its place under the connections cap. An issue whose `until`
  -- has passed is over: it warns of nothing, and stays until the account
  -- reconnects or a new issue replaces it.
  issue jsonb,
  -- The onboarding link (onboarding_tokens.id) the account last connected
  -- through; null when a member connected it in the app. Every signup writes
  -- it, webhooks that reconnect the account don't. No foreign key: a link
  -- deleted afterwards still leaves the account saying it arrived by one.
  onboarding_token_id uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

-- service is part of the key, exactly as in contacts_addresses: one canonical
-- address string can name accounts on two services (bare phone digits are both
-- a 'whatsapp' and a 'whatsapp-web' account), and they are separate
-- connections with separate tokens.
--
-- It is also what lets every dependent FK carry service, so a child row can
-- never claim a service its account does not have.
alter table only public.organizations_addresses
add constraint organizations_addresses_pkey
primary key (organization_id, service, address);

alter table only public.organizations_addresses
add constraint organizations_addresses_issue_reason
check (
  issue is null
  or issue->>'reason' in (
    'logged_out',
    'banned',
    'expired',
    'removed',
    'offboarded',
    'deleted',
    'violation',
    'restricted',
    'locked'
  )
);

alter table only public.organizations_addresses
add constraint organizations_addresses_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade;

create trigger set_extra
before update
on public.organizations_addresses
for each row
when (
  new.extra is not null
)
execute function public.merge_update('extra');

-- An account connected again has nothing left to warn about, whichever path
-- brought it back.
create trigger clear_issue
before update
on public.organizations_addresses
for each row
when (
  old.status <> 'connected' and new.status = 'connected'
)
execute function public.clear_address_issue();

create trigger set_updated_at
before update
on public.organizations_addresses
for each row
execute function public.moddatetime('updated_at');

-- An account's first issue is an email to whoever can reconnect it. Only the
-- first: one that worsens (a violation, then the ban that follows it moments
-- later) or is flagged again stays quiet until the account is reconnected and
-- the issue cleared, or the issue it replaces is over.
create trigger notify_address_issue
after update
on public.organizations_addresses
for each row
when (
  new.issue is not null
  and new.issue is distinct from old.issue
  and (old.issue is null or (old.issue->>'until')::timestamptz < now())
)
execute function public.edge_function('/notifications', 'post');

create trigger z_notify_webhook_organizations_addresses
after insert or update
on public.organizations_addresses
for each row
execute function public.notify_webhook();

create index organizations_addresses_agent_id_idx
on public.organizations_addresses
using btree (agent_id);

create index organizations_addresses_waba_id_idx
on public.organizations_addresses
using btree ((extra->>'waba_id'))
where service = 'whatsapp';

-- Index for efficient phone number lookups (used by MCP server)
create index organizations_addresses_phone_number_idx
on public.organizations_addresses
using btree ((extra->>'phone_number'))
where service = 'whatsapp';
