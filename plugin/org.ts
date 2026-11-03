/**
 * The signed-in user's organizations, invitations and connected accounts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "./config.ts";

export type Role = "owner" | "admin" | "member";

export type Org = {
  orgId: string;
  orgName: string;
  agentId: string; // the signed-in user in this org; replies are theirs
  role: Role;
};

export type Invitation = {
  id: string;
  organization_id: string;
  organization_name: string | null;
  invited_by_name: string | null;
  role: Role;
};

// organization_address → how a person names the account
export type Accounts = Map<string, { service: string; label: string }>;

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
export async function listInvitations(
  supabase: SupabaseClient,
): Promise<Invitation[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return [];

  const { data } = await supabase
    .from("invitations")
    .select(
      "id, organization_id, organization_name, invited_by_name, role, email",
    )
    .eq("status", "pending")
    .throwOnError();

  // Members also read their orgs' invitations to others; only the user's own.
  const email = user.email.toLowerCase();
  return (data ?? []).filter((i) => i.email.toLowerCase() === email);
}

/**
 * Create an organization; the database makes the user its owner. The row is
 * readable only once that membership exists, so the id is chosen here rather
 * than read back from the insert.
 */
export async function createOrg(
  supabase: SupabaseClient,
  name: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await supabase.from("organizations").insert({ id, name }).throwOnError();
  return id;
}

/** Join the organization an invitation is for. */
export async function acceptInvitation(
  supabase: SupabaseClient,
  invitation: Invitation,
): Promise<string> {
  await supabase
    .rpc("accept_invitation", { invitation_id: invitation.id })
    .throwOnError();
  return invitation.organization_id;
}

export function accountLabel(
  address: string,
  extra: Record<string, string | undefined> | null,
): string {
  const e = extra ?? {};
  return e.phone_number ?? (e.username ? `@${e.username}` : undefined) ??
    e.team_name ?? e.verified_name ?? e.name ?? address;
}

export async function resolveAccounts(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Accounts> {
  const { data } = await supabase
    .from("organizations_addresses")
    .select("service, address, extra")
    .eq("organization_id", orgId)
    .eq("status", "connected")
    .neq("service", "local")
    .throwOnError();

  return new Map(
    (data ?? []).map((a) => [
      a.address,
      { service: a.service, label: accountLabel(a.address, a.extra) },
    ]),
  );
}
