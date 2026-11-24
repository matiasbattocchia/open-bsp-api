/**
 * A person's organizations: invitations, creating one, joining one. Shared by
 * the Claude Code plugin and the remote MCP server; neither Node nor Deno.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type Role = "owner" | "admin" | "member";

export type Invitation = {
  id: string;
  organization_id: string;
  organization_name: string | null;
  invited_by_name: string | null;
  role: Role;
};

/** The invitations waiting for this person's own answer. */
export async function listInvitations(
  supabase: SupabaseClient,
  email: string | undefined,
): Promise<Invitation[]> {
  if (!email) return [];

  const { data } = await supabase
    .from("invitations")
    .select(
      "id, organization_id, organization_name, invited_by_name, role, email",
    )
    .eq("status", "pending")
    .throwOnError();

  // Members also read their orgs' invitations to others; only the person's own.
  const own = email.toLowerCase();
  return (data ?? []).filter((i) => i.email.toLowerCase() === own);
}

/**
 * Create an organization; the database makes the person its owner. The row is
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
  invitation: Pick<Invitation, "id" | "organization_id">,
): Promise<string> {
  await supabase
    .rpc("accept_invitation", { invitation_id: invitation.id })
    .throwOnError();
  return invitation.organization_id;
}
