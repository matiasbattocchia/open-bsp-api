import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createUnsecureClient,
  type Database,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import * as log from "../_shared/logger.ts";
import { APP_URL, type Email, sendEmails } from "../_shared/email.ts";
import { type AlertRow, quotaEmail } from "./quota_email.ts";
import { type AddressRow, connectionEmail } from "./connection_email.ts";

/**
 * Emails, sent through Resend from database triggers (public.edge_function):
 *
 *   public.invitations INSERT (pending)            → the invitee
 *   public.invitations UPDATE pending → accepted   → the inviter
 *   billing.alerts     INSERT (near / capped)      → every member
 *   public.organizations_addresses UPDATE, a new issue
 *                                                  → whoever can reconnect it
 *
 * English only: nothing on the server knows a reader's language, and mail
 * clients translate.
 */

type InvitationRow = Database["public"]["Tables"]["invitations"]["Row"];

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = (await req.json()) as WebhookPayload<
    InvitationRow | AlertRow | AddressRow
  >;
  const source = `${payload.schema}.${payload.table}`;

  try {
    const client = createUnsecureClient();

    if (source === "public.invitations") {
      const invitation = payload.record as InvitationRow;
      const before = payload.old_record as InvitationRow | null;

      if (payload.type === "INSERT" && invitation.status === "pending") {
        await invitationReceived(invitation);
      } else if (
        payload.type === "UPDATE" && before?.status === "pending" &&
        invitation.status === "accepted"
      ) {
        await invitationAccepted(invitation);
      }
    } else if (source === "billing.alerts" && payload.type === "INSERT") {
      await quotaAlert(client, payload.record as AlertRow);
    } else if (
      source === "public.organizations_addresses" && payload.type === "UPDATE"
    ) {
      await addressIssue(client, payload.record as AddressRow);
    }

    return new Response();
  } catch (error) {
    log.error("Notification failed", {
      source,
      type: payload.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Internal error", { status: 500 });
  }
});

function asRole(role: string) {
  return role === "member" ? "a member" : `an ${role}`;
}

async function invitationReceived(invitation: InvitationRow) {
  const organization = invitation.organization_name || "an organization";
  const inviter = invitation.invited_by_name
    ? invitation.invited_by_email
      ? `${invitation.invited_by_name} (${invitation.invited_by_email})`
      : invitation.invited_by_name
    : null;

  await sendEmails([{
    to: invitation.email,
    subject: inviter
      ? `${invitation.invited_by_name} invited you to ${organization} on OpenBSP`
      : `You're invited to ${organization} on OpenBSP`,
    lines: [
      `${
        inviter ? `${inviter} invited you` : "You have been invited"
      } to join ${organization} on OpenBSP as ${asRole(invitation.role)}.`,
      `Sign in with ${invitation.email} to accept or decline the invitation.`,
    ],
    action: { label: "Open OpenBSP", url: APP_URL },
  }], `invitation-received/${invitation.id}`);
}

async function invitationAccepted(invitation: InvitationRow) {
  if (!invitation.invited_by_email) return;

  const organization = invitation.organization_name || "your organization";

  await sendEmails([{
    to: invitation.invited_by_email,
    subject: `${invitation.email} joined ${organization}`,
    lines: [
      `${invitation.email} accepted your invitation and joined ${organization} on OpenBSP as ${
        asRole(invitation.role)
      }.`,
    ],
    action: { label: "See members", url: `${APP_URL}/settings/members` },
  }], `invitation-accepted/${invitation.id}`);
}

async function quotaAlert(client: SupabaseClient<Database>, alert: AlertRow) {
  const [{ data: organization }, { data: product }, { data: members }] =
    await Promise.all([
      client.from("organizations").select("name").eq(
        "id",
        alert.organization_id,
      ).single().throwOnError(),
      client.schema("billing").from("products").select("name, kind, unit")
        .eq("id", alert.product_id).single().throwOnError(),
      client.from("agents").select("user_id").eq(
        "organization_id",
        alert.organization_id,
      ).not("user_id", "is", null).is("deleted_at", null).throwOnError(),
    ]);

  const emails = new Set<string>();

  for (const { user_id } of members ?? []) {
    const { data } = await client.auth.admin.getUserById(user_id!);
    if (data.user?.email) emails.add(data.user.email);
  }

  const content = quotaEmail(organization.name, product, alert);

  await sendEmails(
    [...emails].map((to): Email => ({ to, ...content })),
    `quota/${alert.organization_id}/${alert.product_id}/${alert.period}/${alert.level}/${alert.created_at}`,
  );
}

/**
 * An account the service disconnected (see organizations_addresses.issue), to
 * whoever can reconnect it: the member a personal account belongs to, or the
 * organization's admins and owners for its own.
 */
async function addressIssue(
  client: SupabaseClient<Database>,
  row: AddressRow,
) {
  if (!row.issue) return;

  let agents = client.from("agents").select("user_id").eq(
    "organization_id",
    row.organization_id,
  ).not("user_id", "is", null).is("deleted_at", null);

  agents = row.agent_id
    ? agents.eq("id", row.agent_id)
    : agents.in("role", ["admin", "owner"]);

  const [{ data: organization }, { data: members }] = await Promise.all([
    client.from("organizations").select("name").eq("id", row.organization_id)
      .single().throwOnError(),
    agents.throwOnError(),
  ]);

  const emails = new Set<string>();

  for (const { user_id } of members ?? []) {
    const { data } = await client.auth.admin.getUserById(user_id!);
    if (data.user?.email) emails.add(data.user.email);
  }

  const content = connectionEmail(organization.name, row);

  await sendEmails(
    [...emails].map((to): Email => ({ to, ...content })),
    `address-issue/${row.organization_id}/${row.service}/${row.address}/${row.updated_at}`,
  );
}
