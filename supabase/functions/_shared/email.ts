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

// The app's theme (open-bsp-ui global.css), its oklch tokens in hex: mail
// clients take neither custom properties nor oklch, and most take styles only
// inline. The dark palette applies where a client honours the media query.
const THEME = {
  font:
    "'Segoe UI','Helvetica Neue',Helvetica,'Lucida Grande',Arial,Ubuntu,Cantarell,'Fira Sans',sans-serif",
  background: "#faf8f1",
  card: "#ffffff",
  foreground: "#3d3826",
  primary: "#cb6441",
  primaryForeground: "#ffffff",
  muted: "#85837d",
  border: "#d9d8d0",
  dark: {
    background: "#1f1f1f",
    card: "#262626",
    foreground: "#c3c1ba",
    primary: "#d87757",
    muted: "#b7b5a6",
    border: "#3e3e38",
  },
};

function render({ lines, action }: Email) {
  const text = [
    ...lines,
    ...(action ? [`${action.label}: ${action.url}`] : []),
  ].join("\n\n");

  const t = THEME;

  const paragraphs = lines
    .map((line) =>
      `<p class="fg" style="margin:0 0 16px;color:${t.foreground}">${
        escapeHtml(line)
      }</p>`
    )
    .join("");

  const button = action
    ? `<p style="margin:28px 0 4px"><a class="btn" href="${
      escapeHtml(action.url)
    }" style="background:${t.primary};color:${t.primaryForeground};padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">${
      escapeHtml(action.label)
    }</a></p>`
    : "";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<style>
@media (prefers-color-scheme: dark) {
  .bg { background:${t.dark.background} !important; }
  .card { background:${t.dark.card} !important; border-color:${t.dark.border} !important; }
  .fg { color:${t.dark.foreground} !important; }
  .muted { color:${t.dark.muted} !important; }
  .btn { background:${t.dark.primary} !important; }
}
</style></head>
<body class="bg" style="margin:0;padding:0;background:${t.background}">
<div class="bg" style="background:${t.background};padding:32px 16px;font-family:${t.font};font-size:15px;line-height:1.55">
<div class="card" style="max-width:520px;margin:0 auto;background:${t.card};border:1px solid ${t.border};border-radius:12px;padding:32px">
<p style="margin:0 0 24px"><img src="${APP_URL}/logo-192x192.png" width="40" height="40" alt="OpenBSP" style="display:block;border-radius:8px"></p>
${paragraphs}${button}
</div>
<p class="muted" style="max-width:520px;margin:16px auto 0;text-align:center;color:${t.muted};font-size:13px">OpenBSP · <a class="muted" href="${APP_URL}" style="color:${t.muted}">${
    APP_URL.replace(/^https?:\/\//, "")
  }</a></p>
</div>
</body></html>`;

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
