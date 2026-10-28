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
  -- { reason: 'logged_out' | 'banned' | 'expired', until?: ISO } — a ban that
  -- says when it lifts carries `until`. Usually on a disconnected row; an
  -- Instagram token that died keeps its row connected, since messages still
  -- arrive and the account keeps its place under the connections cap.
  issue jsonb,
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
check (issue is null or issue->>'reason' in ('logged_out', 'banned', 'expired'));

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

-- A new issue is an email to whoever can reconnect the account.
create trigger notify_address_issue
after update
on public.organizations_addresses
for each row
when (
  new.issue is not null and old.issue is distinct from new.issue
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
