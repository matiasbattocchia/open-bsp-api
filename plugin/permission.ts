/**
 * What Claude may do beyond reading, enforced here rather than asked of it:
 * nothing, each send or change once the user approves it in a dialog, or
 * anything. It holds in every Claude Code permission mode, bypass included.
 */

import { loadConfig, type Permission } from "./config.ts";
import { Back, canShowMenus, form, Stopped, type Ui } from "./menus.ts";

export const PERMISSIONS: Record<Permission, string> = {
  read: "Read only: never send or change anything",
  ask: "Ask me before each send or change",
  allow: "Allow sends and changes",
};

/** For the inbox and the instructions: how the mode bears on replying. */
export const PERMISSION_NOTES: Record<Permission, string> = {
  read:
    "Permission mode: read only — the reply tool and every change are refused. Summarize, and draft answers in chat if the user wants them.",
  ask:
    "Permission mode: ask — each reply opens a dialog where the user approves it, showing only its start: write each answer in the chat as you send it with the reply tool. Don't also ask in chat.",
  allow: "Permission mode: allow — a reply goes out as soon as you send it.",
};

// Reads sent with another method: the template list takes a body.
const READS = [["PUT", "/functions/v1/whatsapp-management/templates"]];

export function isChange(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  const route = path.split("?")[0];
  return !READS.some(([m, p]) => m === method && p === route);
}

function refused(what: string): Error {
  return new Error(
    `${what}: the user's permission mode is read only. Show them the draft instead; /openbsp:setup permissions changes the mode.`,
  );
}

async function approve<T>(
  ui: Ui,
  what: string,
  dialog: () => Promise<T>,
): Promise<T> {
  if (!canShowMenus(ui.mcp)) {
    throw new Error(
      `${what}: the user's permission mode asks before each send or change, and this client can't show the dialog. Show them the draft instead.`,
    );
  }
  try {
    return await dialog();
  } catch (err) {
    if (err instanceof Back || err instanceof Stopped) {
      throw new Error(
        `${what}: the user declined it. Leave it to them; don't send it another way.`,
      );
    }
    throw err;
  }
}

// The TUI shows a dialog's first three lines, each cut to the terminal's
// width: the text gets two short ones, the rest is in the chat.
const LINE = 100;

function wrap(text: string, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > LINE) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.length > lines
    ? [...out.slice(0, lines - 1), `${out[lines - 1].slice(0, LINE - 2)} …`]
    : out;
}

/** Throws unless the user lets this text go out. */
export async function approveReply(
  ui: Ui,
  to: string,
  text: string,
): Promise<void> {
  const mode = loadConfig().permission;
  if (mode === "allow") return;
  if (mode === "read") throw refused("Not sent");

  await approve(ui, "Not sent", () =>
    form(
      ui,
      [
        `Send this to ${to}? Accept sends it, Decline doesn't.`,
        ...wrap(text, 2),
      ].join("\n"),
      {},
    ));
}

/** Throws unless the user lets this change through. */
export async function approveChange(
  ui: Ui,
  method: string,
  path: string,
  body: unknown,
): Promise<void> {
  if (!isChange(method, path)) return;
  const mode = loadConfig().permission;
  if (mode === "allow") return;
  if (mode === "read") throw refused("Not done");

  const shown = body === undefined ? "" : JSON.stringify(body);
  await approve(ui, "Not done", () =>
    form(
      ui,
      [
        `Claude wants to ${method} ${path}.`,
        "Accept allows it, Decline doesn't.",
        shown.length > LINE ? `${shown.slice(0, LINE - 2)} …` : shown,
      ].filter(Boolean).join("\n"),
      {},
    ));
}
