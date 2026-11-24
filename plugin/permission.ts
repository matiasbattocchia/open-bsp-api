/**
 * The permission mode where the hooks module can't enforce it. Claude Code
 * runs hooks/register.ts, which puts each send or change to the user with the
 * mode they set in /config, and calls the `hooks` tool as this server's first
 * tool call. Without it (hooks disabled, an older Claude Code, another
 * client) this server enforces the mode it was started with, in a dialog of
 * its own.
 */

import process from "node:process";
import { Back, canShowDialogs, form, Stopped, type Ui } from "./dialogs.ts";
import {
  isChange,
  parsePermission,
  type Permission,
  PERMISSION_NOTES,
} from "./modes.ts";

let byHooks = false;

/** Whether the hooks module guards sends and changes in this session. */
export function guarded(): boolean {
  return byHooks;
}

/** The hooks module guards from now on; only as the first tool call. */
export function guardedByHooks(): void {
  byHooks = true;
}

/** The mode set in /config when Claude Code started this server. */
const mode: Permission = parsePermission(process.env.OPENBSP_PERMISSION);

/** For the inbox: how the mode bears on replying, unless the hooks say it. */
export function modeNote(): string | undefined {
  if (byHooks) return undefined;
  return mode === "ask"
    ? "Permission mode: ask — each reply opens a dialog where the user approves it, showing only its start: write each answer in the chat as you send it with the reply tool. Don't also ask in chat."
    : PERMISSION_NOTES[mode];
}

function refused(what: string): Error {
  return new Error(
    `${what}: the user's permission mode is read only. Show them the draft instead; they change the mode in /config (OpenBSP).`,
  );
}

async function approve<T>(
  ui: Ui,
  what: string,
  dialog: () => Promise<T>,
): Promise<T> {
  if (!canShowDialogs(ui.mcp)) {
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
  if (byHooks || mode === "allow") return;
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
  if (byHooks || !isChange(method, path) || mode === "allow") return;
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
