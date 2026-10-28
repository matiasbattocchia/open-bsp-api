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
  // Older WhatsApp rows keep the number formatted, "+1 555 616 1619".
  return `+${(extra.phone_number || row.address).replace(/^\+/, "")}`;
}

/** Why Meta took a coexistence number away, when it says. */
const REMOVED: Record<string, string> = {
  ACCOUNT_DISCONNECTED:
    "The number was disconnected from OpenBSP in the WhatsApp Business app.",
  CHANGE_NUMBER: "The number was changed in the WhatsApp Business app.",
  PRIMARY_INACTIVITY:
    "The WhatsApp Business app went too long without being opened on the phone.",
  USER_RE_REGISTERED: "The number was registered on WhatsApp again.",
};

function date(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

/** What happened and what it stopped, by the issue's reason. */
function cause(row: AddressRow, issue: OrganizationAddressIssue) {
  const reinstated = "It reconnects by itself if Meta reinstates the account.";

  switch (issue.reason) {
    case "logged_out":
      return [
        "WhatsApp unlinked the device: it was logged out from the phone, or the phone went too long without connecting.",
        "Messages aren't sent or received until it's reconnected.",
      ];
    case "banned":
      if (row.service === "whatsapp") {
        return [
          "Meta disabled the WhatsApp Business account for violating its policies.",
          `Messages aren't sent or received. ${reinstated}`,
        ];
      }
      return [
        `WhatsApp temporarily banned the number${
          issue.until ? ` until ${date(issue.until)}` : ""
        }.`,
        "Messages aren't sent or received meanwhile. Reconnect it once the ban lifts.",
      ];
    case "violation":
      return [
        `Meta reported a policy violation on the WhatsApp Business account${
          issue.detail
            ? `: ${issue.detail.toLowerCase().replaceAll("_", " ")}`
            : ""
        }.`,
        `Messages aren't sent or received. ${reinstated}`,
      ];
    case "expired":
      return row.service === "instagram"
        ? [
          "Instagram's access expired or was revoked, as happens after a password change.",
          "Messages can't be sent until it's reconnected.",
        ]
        : [
          "The access the account gave OpenBSP expired or was revoked.",
          "Messages can't be sent until it's reconnected.",
        ];
    case "removed":
      return [
        row.service === "instagram"
          ? "OpenBSP was removed from the Instagram account's settings."
          : (issue.detail && REMOVED[issue.detail]) ||
            "OpenBSP's access to the WhatsApp Business account was removed in Meta.",
        "Messages aren't sent or received until it's reconnected.",
      ];
    case "offboarded":
      return [
        "The WhatsApp Business app stopped sharing the number with OpenBSP, after a change of phone or the number being registered again.",
        "Messages aren't sent or received meanwhile. It reconnects by itself once the app is set up again.",
      ];
    case "deleted":
      return [
        "The number or its WhatsApp Business account was deleted in Meta.",
        "Messages can't be sent or received with it anymore.",
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
  // Only where reconnecting is the member's move.
  const reconnect = ["logged_out", "expired", "removed"].includes(
    issue.reason,
  ) || (issue.reason === "banned" && row.service !== "whatsapp");

  return {
    subject: `${service} ${label(row)} was disconnected from ${org}`,
    lines: [
      // A violation is reported by Meta, and the disconnect is ours.
      issue.reason === "violation"
        ? `To protect the platform, OpenBSP disconnected ${
          label(row)
        } from ${org}.`
        : `${service} disconnected ${label(row)} from ${org} on OpenBSP.`,
      ...cause(row, issue),
    ],
    action: {
      label: reconnect ? "Reconnect" : "See account",
      url: `${APP_URL}/integrations/${row.service}/${
        encodeURIComponent(row.address)
      }`,
    },
  };
}
