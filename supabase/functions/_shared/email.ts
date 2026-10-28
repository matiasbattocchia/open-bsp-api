import * as log from "./logger.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ||
  "OpenBSP <notifications@openbsp.dev>";

/** Where links in an email point: the app's origin, without a trailing slash. */
export const APP_URL = (Deno.env.get("APP_URL") || "https://web.openbsp.dev")
  .replace(/\/+$/, "");

export type Email = {
  to: string;
  subject: string;
  /** Paragraphs of plain text; the HTML part is built from the same lines. */
  lines: string[];
  action?: { label: string; url: string };
};

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function render({ lines, action }: Email) {
  const text = [
    ...lines,
    ...(action ? [`${action.label}: ${action.url}`] : []),
  ].join("\n\n");

  const paragraphs = lines
    .map((line) => `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`)
    .join("");

  const button = action
    ? `<p style="margin:24px 0"><a href="${
      escapeHtml(action.url)
    }" style="background:#111827;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${
      escapeHtml(action.label)
    }</a></p>`
    : "";

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111827;max-width:560px">${paragraphs}${button}<p style="margin:32px 0 0;color:#6b7280;font-size:13px">OpenBSP</p></div>`;

  return { text, html };
}

/**
 * Sends each email on its own (recipients never see each other) in one Resend
 * batch call. The idempotency key makes a retried batch a no-op on Resend's
 * side. Without RESEND_API_KEY — local development — the emails are logged
 * instead of sent.
 */
export async function sendEmails(emails: Email[], idempotencyKey: string) {
  if (emails.length === 0) return;

  if (!RESEND_API_KEY) {
    log.warn("RESEND_API_KEY not set, not sending emails", {
      to: emails.map((e) => e.to),
      subjects: emails.map((e) => e.subject),
    });
    return;
  }

  const response = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(
      emails.map((email) => ({
        from: EMAIL_FROM,
        to: [email.to],
        subject: email.subject,
        ...render(email),
      })),
    ),
  });

  if (!response.ok) {
    throw new Error(
      `Resend responded ${response.status}: ${await response.text()}`,
    );
  }
}
