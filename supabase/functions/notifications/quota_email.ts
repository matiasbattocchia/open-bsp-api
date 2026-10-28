import type { Database } from "../_shared/supabase.ts";
import { APP_URL, type Email } from "../_shared/email.ts";

export type AlertRow = Database["billing"]["Tables"]["alerts"]["Row"];

type Product = { name: string; kind: string; unit: string };

/** What stops working at the cap, by the trigger that enforces it. */
const CONSEQUENCE: Record<string, string> = {
  messages: "sending messages pauses; incoming messages keep arriving",
  conversations: "new conversations can't be started",
  storage:
    "files can't be uploaded, and incoming media arrives without its file",
  organizations_addresses: "no more accounts can be connected",
  ai_credits: "AI agents without their own API key stop replying",
};

// Rounded down, so usage short of the cap never reads as the cap itself
// (0.998 GB is "0.99 GB of 1 GB", not "1 GB of 1 GB" at 99%).
function amount(quantity: number, unit: string) {
  const number = (Math.floor(quantity * 100) / 100).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
  if (unit === "usd") return `$${number}`;
  if (unit === "count") return number;
  return `${number} ${unit.toUpperCase()}`;
}

/** The quota email for one alert, the same for every member who gets it. */
export function quotaEmail(
  org: string,
  product: Product,
  alert: AlertRow,
): Omit<Email, "to"> {
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
      ? `${org} has no ${name} left.`
      : `${org} has ${used} of ${name} left.`;
  } else {
    const percent = Math.floor((alert.quantity / alert.cap) * 100);
    subject = capped
      ? `${org} reached its ${name.toLowerCase()} limit`
      : `${org} is at ${percent}% of its ${name.toLowerCase()} limit`;
    summary = `${org} has used ${used} of ${cap} ${name.toLowerCase()}${
      monthly ? " this month" : ""
    }.`;
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

  return {
    subject,
    lines,
    action: { label: "See plans", url: `${APP_URL}/settings/plans` },
  };
}
