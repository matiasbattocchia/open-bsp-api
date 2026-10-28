import type { Database } from "../_shared/supabase.ts";
import { APP_URL, type Email } from "../_shared/email.ts";
import type { OrganizationAddressIssue } from "../_shared/types/extra_types.ts";

export type AddressRow =
  Database["public"]["Tables"]["organizations_addresses"]["Row"];

const SERVICE: Record<string, string> = {
  whatsapp: "WhatsApp",
  "whatsapp-web": "WhatsApp Web",
  instagram: "Instagram",
};

/** How the account reads in the app: its number, or its @username. */
function label(row: AddressRow) {
  const extra = (row.extra ?? {}) as {
    phone_number?: string;
    username?: string;
  };
  if (row.service === "instagram") {
    return extra.username ? `@${extra.username}` : row.address;
  }
  return `+${extra.phone_number || row.address}`;
}

/** What happened and what it stopped, by the issue's reason. */
function cause(issue: OrganizationAddressIssue) {
  switch (issue.reason) {
    case "logged_out":
      return [
        "WhatsApp unlinked the device: it was logged out from the phone, or the phone went too long without connecting.",
        "Messages aren't sent or received until it's reconnected.",
      ];
    case "banned":
      return [
        `WhatsApp temporarily banned the number${
          issue.until
            ? ` until ${
              new Date(issue.until).toLocaleString("en-US", {
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZone: "UTC",
                timeZoneName: "short",
              })
            }`
            : ""
        }.`,
        "Messages aren't sent or received meanwhile. Reconnect it once the ban lifts.",
      ];
    case "expired":
      return [
        "Instagram's access expired or was revoked, as happens after a password change.",
        "Messages can't be sent until it's reconnected.",
      ];
  }
}

/** The email for an account the service disconnected, the same for everyone who gets it. */
export function connectionEmail(
  org: string,
  row: AddressRow,
): Omit<Email, "to"> {
  const issue = row.issue as OrganizationAddressIssue;
  const service = SERVICE[row.service] ?? row.service;

  return {
    subject: `${service} ${label(row)} was disconnected from ${org}`,
    lines: [
      `${service} disconnected ${label(row)} from ${org} on OpenBSP.`,
      ...cause(issue),
    ],
    action: {
      label: "Reconnect",
      url: `${APP_URL}/integrations/${row.service}/${
        encodeURIComponent(row.address)
      }`,
    },
  };
}
