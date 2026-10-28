import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createUnsecureClient,
  type Database,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import * as log from "../_shared/logger.ts";
import { APP_URL, type Email, sendEmails } from "../_shared/email.ts";

/**
 * Emails, sent through Resend from database triggers (public.edge_function):
 *
 *   public.invitations INSERT (pending)            → the invitee
 *   public.invitations UPDATE pending → accepted   → the inviter
 *   billing.alerts     INSERT (near / capped)      → every member
 *
 * English only: nothing on the server knows a reader's language, and mail
 * clients translate.
 */

type InvitationRow = Database["public"]["Tables"]["invitations"]["Row"];
type AlertRow = Database["billing"]["Tables"]["alerts"]["Row"];

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = (await req.json()) as WebhookPayload<
    InvitationRow | AlertRow
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

/** What stops working at the cap, by the trigger that enforces it. */
const CONSEQUENCE: Record<string, string> = {
  messages: "sending messages pauses; incoming messages keep arriving",
  conversations: "new conversations can't be started",
  storage:
    "files can't be uploaded, and incoming media arrives without its file",
  organizations_addresses: "no more accounts can be connected",
  ai_credits: "AI agents without their own API key stop replying",
};

function amount(quantity: number, unit: string) {
  const number = quantity.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
  if (unit === "usd") return `$${number}`;
  if (unit === "count") return number;
  return `${number} ${unit.toUpperCase()}`;
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

  const org = organization.name;
  const name = product.name;
  const capped = alert.level === "capped";
  const monthly = alert.interval === "month";
  const used = amount(alert.quantity, product.unit);
  const cap = amount(alert.cap, product.unit);
  const consequence = CONSEQUENCE[alert.product_id] ??
    "it can't be used any further";

  let subject: string;
  let summary: string;

  if (product.kind === "balance") {
    subject = capped
      ? `${org} has run out of ${name}`
      : `${org} is running low on ${name}`;
    summary = capped
      ? `${org} has no ${name} left on OpenBSP.`
      : `${org} has ${used} of ${name} left on OpenBSP.`;
  } else {
    const percent = Math.floor((alert.quantity / alert.cap) * 100);
    subject = capped
      ? `${org} reached its ${name.toLowerCase()} limit`
      : `${org} is at ${percent}% of its ${name.toLowerCase()} limit`;
    summary = `${org} has used ${used} of ${cap} ${name.toLowerCase()}${
      monthly ? " this month" : ""
    } on OpenBSP.`;
  }

  const effect = capped
    ? `${consequence[0].toUpperCase()}${consequence.slice(1)}.`
    : `At the limit, ${consequence}.`;

  const next = new Date(alert.period);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const renewal = monthly
    ? `The quota renews on ${
      next.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    }.`
    : null;

  const lines = [
    summary,
    effect,
    ...(renewal ? [renewal] : []),
    "A higher plan raises the limit.",
  ];

  await sendEmails(
    [...emails].map((to): Email => ({
      to,
      subject,
      lines,
      action: { label: "See plans", url: `${APP_URL}/settings/plans` },
    })),
    `quota/${alert.organization_id}/${alert.product_id}/${alert.period}/${alert.level}/${alert.created_at}`,
  );
}
