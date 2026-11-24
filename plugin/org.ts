/**
 * The signed-in user's organizations, invitations and connected accounts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "./config.ts";
import {
  listInvitations as invitationsFor,
  type Role,
} from "../supabase/functions/_shared/organizations.ts";

export {
  acceptInvitation,
  createOrg,
  type Invitation,
  type Role,
} from "../supabase/functions/_shared/organizations.ts";
export {
  accountLabel,
  type Accounts,
  resolveAccounts,
} from "../supabase/functions/_shared/inbox.ts";

export type Org = {
  orgId: string;
  orgName: string;
  agentId: string; // the signed-in user in this org; replies are theirs
  role: Role;
};

/** Every organization the user is a member of. */
export async function listOrgs(supabase: SupabaseClient): Promise<Org[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: agents } = await supabase
    .from("agents")
    .select("id, organization_id, role, organizations(name)")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at")
    .throwOnError();

  return (agents ?? []).map((agent) => ({
    orgId: agent.organization_id,
    orgName: (agent.organizations as unknown as { name?: string } | null)
      ?.name ?? agent.organization_id,
    agentId: agent.id,
    role: agent.role,
  }));
}

/** The configured organization, or the user's first one. */
export async function resolveOrg(supabase: SupabaseClient): Promise<Org> {
  const orgs = await listOrgs(supabase);

  if (orgs.length === 0) {
    throw new Error(
      "No organization yet — the setup tool creates one or joins an invitation",
    );
  }

  const { orgId } = loadConfig();
  const org = orgId ? orgs.find((o) => o.orgId === orgId) : orgs[0];

  if (!org) {
    const ids = orgs.map((o) => o.orgId).join(", ");
    throw new Error(`Organization ${orgId} not found. Available: ${ids}`);
  }

  return org;
}

/** The invitations waiting for the user's own answer. */
export async function listInvitations(supabase: SupabaseClient) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return await invitationsFor(supabase, user?.email);
}
