// Who calls the remote MCP server, and what it remembers for them. A person
// (OAuth) works in one of their organizations: the one they chose last. An
// API key works in its own. The server keeps nothing between requests: what
// it remembers for a person (the organization they chose, where their inbox
// left off) lives on their membership, agents.extra.mcp, which RLS lets them
// update.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../_shared/supabase.ts";
import type { HumanAgentExtra } from "../_shared/types/extra_types.ts";
import type { Role } from "../_shared/organizations.ts";

type Client = SupabaseClient<Database>;

export type Person = {
  kind: "person";
  supabase: Client;
  token: string;
  userId: string;
  email?: string;
};

export type Key = {
  kind: "key";
  supabase: Client;
  key: string;
  name: string;
  orgId: string;
  role: Role;
  // Phone numbers (digits) the caller narrowed the key to, by header.
  allowedContacts: string[];
  allowedAccounts: string[];
};

export type Caller = Person | Key;

export type Membership = {
  agentId: string;
  orgId: string;
  orgName: string;
  role: Role;
  pickedAt?: string;
  inboxCursor?: string;
};

/** Where a tool works: the organization, and who in it. */
export type Workspace = {
  orgId: string;
  role: Role;
  /** The person's membership; none for an API key. */
  membership?: Membership;
};

export const NO_ORG =
  "No organization yet: set_organization creates one, or joins one the user was invited to (organizations lists the invitations).";

/** The person's current memberships, oldest first. */
export async function memberships(person: Person): Promise<Membership[]> {
  const { data } = await person.supabase
    .from("agents")
    .select("id, organization_id, role, extra, organizations(name)")
    .eq("user_id", person.userId)
    .is("deleted_at", null)
    .order("created_at")
    .throwOnError();

  return data.map((agent) => {
    const mcp = (agent.extra as HumanAgentExtra | null)?.mcp;
    return {
      agentId: agent.id,
      orgId: agent.organization_id,
      orgName: (agent.organizations as { name?: string } | null)?.name ??
        agent.organization_id,
      role: agent.role,
      pickedAt: mcp?.picked_at,
      inboxCursor: mcp?.inbox_cursor,
    };
  });
}

/** The organization a person works in: the one chosen last, else the first. */
export function current(list: Membership[]): Membership | undefined {
  return list.reduce<Membership | undefined>(
    (best, m) => !best || (m.pickedAt ?? "") > (best.pickedAt ?? "") ? m : best,
    undefined,
  );
}

/** Where the caller's tools work; a person with no organization can't yet. */
export async function workspace(caller: Caller): Promise<Workspace> {
  if (caller.kind === "key") return { orgId: caller.orgId, role: caller.role };

  const membership = current(await memberships(caller));
  if (!membership) throw new Error(NO_ORG);
  return { orgId: membership.orgId, role: membership.role, membership };
}

/** Remember something for the person in this organization (merged in). */
export async function remember(
  person: Person,
  membership: Membership,
  mcp: NonNullable<HumanAgentExtra["mcp"]>,
): Promise<void> {
  await person.supabase
    .from("agents")
    .update({ extra: { mcp } })
    .eq("id", membership.agentId)
    .throwOnError();
}
