import type { Database } from "../_shared/supabase.ts";
import { APP_URL, type Email } from "../_shared/email.ts";
import type { OrganizationAddressIssue } from "../_shared/types/extra_types.ts";

export type AddressRow =
  Database["public"]["Tables"]["organizations_addresses"]["Row"];

const SERVICE: Record<string, string> = {
  whatsapp: "WhatsApp",
  "whatsapp-web": "WhatsApp Web",
  instagram: "Instagram",
  tiktok: "TikTok",
  slack: "Slack",
};

/** Where to ask OpenBSP about a decision on an account. */
const COMMUNITY = "https://chat.whatsapp.com/Ch6AwZizSDt5quzHodcYh5";

/** Where Meta reviews what it decided on a WhatsApp Business account. */
const APPEAL =
  "If you think it's a mistake, request a review from Meta in Business Support Home (business.facebook.com/business-support-home), also linked from WhatsApp Manager.";

/** How the account reads in the app: its number, or its @username. */
function label(row: AddressRow) {
  const extra = (row.extra ?? {}) as {
    phone_number?: string;
    username?: string;
  };
  if (row.service === "instagram" || row.service === "tiktok") {
    return extra.username ? `@${extra.username}` : row.address;
  }
  // Older WhatsApp rows keep the number formatted, "+1 555 616 1619".
  return `+${(extra.phone_number || row.address).replace(/^\+/, "")}`;
}

/**
 * The account as the email names it: the service and its number or
 * @username, a Slack workspace, or a member's own Slack account.
 */
function named(row: AddressRow) {
  const service = SERVICE[row.service] ?? row.service;
  if (row.service === "slack") {
    if (row.agent_id) return `your ${service} account`;
    const extra = (row.extra ?? {}) as { team_name?: string };
    return `${service} workspace ${extra.team_name || row.address}`;
  }
  return `${service} ${label(row)}`;
}

const capitalized = (text: string) => text[0].toUpperCase() + text.slice(1);

/** What a restriction stops, by Meta's name for it. */
const RESTRICTION: Record<string, string> = {
  RESTRICTED_BIZ_INITIATED_MESSAGING:
    "it can't start conversations, only reply to customers who write first",
  RESTRICTED_CUSTOMER_INITIATED_MESSAGING: "it can't reply to customers",
  RESTRICTED_ADD_PHONE_NUMBER_ACTION: "no numbers can be added to it",
};

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
          APPEAL,
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
        APPEAL,
      ];
    case "restricted":
      return [
        `Meta restricted the WhatsApp Business account${
          issue.until ? ` until ${date(issue.until)}` : ""
        }: ${
          (issue.detail ?? "").split(",").filter(Boolean).map((type) =>
            RESTRICTION[type] ?? type.toLowerCase().replaceAll("_", " ")
          ).join("; ")
        }.`,
        "Everything else keeps working, and the restriction lifts by itself.",
        APPEAL,
      ];
    case "locked":
      return [
        "Meta locked the WhatsApp Business account, for violating its policies or because the two-step verification PIN doesn't match.",
        "Messages can't be sent until Meta unlocks it.",
        APPEAL,
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
          : row.service === "slack"
          ? "OpenBSP was removed from the Slack workspace, or its access revoked."
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

/**
 * The email for an account the service broke, the same for everyone who gets
 * it. A dead token, a restriction and a lock leave the account connected, the
 * rest disconnect it.
 */
export function connectionEmail(
  org: string,
  row: AddressRow,
): Omit<Email, "to"> {
  const issue = row.issue as OrganizationAddressIssue;
  const account = named(row);
  // Only where reconnecting is the member's move.
  const reconnect = ["logged_out", "expired", "removed"].includes(
    issue.reason,
  ) || (issue.reason === "banned" && row.service !== "whatsapp");

  const subject = {
    expired: `${capitalized(account)} needs reconnecting on ${org}`,
    restricted: `${capitalized(account)} is restricted on ${org}`,
    locked: `${capitalized(account)} is locked on ${org}`,
  }[issue.reason as string] ??
    `${capitalized(account)} was disconnected from ${org}`;

  return {
    subject,
    lines: [
      ...(["expired", "restricted", "locked"].includes(issue.reason)
        ? []
        // A violation is reported by Meta, and the disconnect is ours.
        : issue.reason === "violation"
        ? [
          `To protect the platform, OpenBSP disconnected ${account} from ${org}.`,
        ]
        : [`${capitalized(account)} was disconnected from ${org} on OpenBSP.`]),
      ...cause(row, issue),
      // Meta's decisions, which OpenBSP acts on.
      ...(row.service === "whatsapp" &&
          ["violation", "banned", "restricted", "locked"].includes(
            issue.reason,
          )
        ? [`Questions for OpenBSP: ${COMMUNITY}`]
        : []),
    ],
    action: {
      label: reconnect ? "Reconnect" : "See account",
      // Slack accounts have no page of their own.
      url: row.service === "slack"
        ? `${APP_URL}/integrations`
        : `${APP_URL}/integrations/${row.service}/${
          encodeURIComponent(row.address)
        }`,
    },
  };
}
