/**
 * Dialogs in the Claude Code TUI, through MCP elicitation: a form, and a
 * dialog kept open while the user does something elsewhere. Accept goes on,
 * Decline goes back, Esc stops. Choices are Claude's to ask (setup.ts).
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { openBrowser } from "./auth.ts";

/** Where dialogs show; aborting the signal (the tool call's) retracts them. */
export type Ui = { mcp: Server; signal?: AbortSignal };

type Field =
  | { type: "string"; title: string; description?: string; default?: string }
  | { type: "boolean"; title: string; description?: string; default?: boolean };

/** Decline: the user goes back a step. */
export class Back extends Error {
  constructor() {
    super("Cancelled by the user");
  }
}

/** Esc: the user stops. */
export class Stopped extends Error {
  constructor() {
    super("Cancelled by the user");
  }
}

function leave(action: string): never {
  throw action === "decline" ? new Back() : new Stopped();
}

type Support = { form?: object; url?: object };

function support(mcp: Server): Support | undefined {
  return mcp.getClientCapabilities()?.elicitation as Support | undefined;
}

// A dialog waits on a person: the SDK's default request timeout (60s) would
// retract a dialog the user is still reading.
const DIALOG_TIMEOUT_MS = 60 * 60_000;

const signals = (ui: Ui, own: AbortSignal) =>
  ui.signal ? AbortSignal.any([own, ui.signal]) : own;

/** Whether the client shows forms; an empty declaration means forms. */
export function canShowDialogs(mcp: Server): boolean {
  const s = support(mcp);
  return !!s && (!!s.form || !s.url);
}

/** A form's values once accepted; throws Back or Stopped otherwise. */
export async function form(
  ui: Ui,
  message: string,
  properties: Record<string, Field>,
  required: string[] = [],
): Promise<Record<string, string | boolean>> {
  const res = await ui.mcp.elicitInput({
    message,
    requestedSchema: { type: "object", properties, required },
  }, { signal: ui.signal, timeout: DIALOG_TIMEOUT_MS });
  if (res.action !== "accept") leave(res.action);
  return (res.content ?? {}) as Record<string, string | boolean>;
}

/** One line of text; null when left empty. */
export async function ask(
  ui: Ui,
  message: string,
  field: { title: string; description?: string; default?: string },
): Promise<string | null> {
  const answer = await form(ui, message, {
    value: { type: "string", ...field },
  }, ["value"]);
  return (answer.value as string | undefined)?.trim() || null;
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

type Dialog = Parameters<Server["elicitInput"]>[0];

/**
 * Show a dialog until the user answers it or `done` lands, whichever is
 * first; a dialog still open when `done` lands is retracted.
 */
async function race<T>(
  ui: Ui,
  params: Dialog,
  done: Promise<T>,
): Promise<{ landed: true; value: T } | { landed: false; action: string }> {
  const ac = new AbortController();
  let open = true;
  const answered = ui.mcp.elicitInput(params, {
    signal: signals(ui, ac.signal),
    timeout: DIALOG_TIMEOUT_MS,
  })
    .then((res) => {
      open = false;
      return { landed: false as const, action: res.action };
    });
  answered.catch(() => {}); // the losing branch must not go unhandled

  try {
    return await Promise.race([
      done.then((value) => ({ landed: true as const, value })),
      answered,
    ]);
  } finally {
    if (open) ac.abort(); // retract it
  }
}

/**
 * Keep a dialog open while the user does something elsewhere — signs in or
 * connects an account in the browser, types a code on their phone — and
 * close it as soon as `done` lands. A `url` opens in the browser (unless
 * already `opened`), and the dialog shows it in case it didn't. Leaving the
 * dialog calls `cancel` and throws Back or Stopped.
 */
export async function waitFor<T>(
  ui: Ui,
  opts: {
    message: string;
    url?: string;
    opened?: boolean;
    done: Promise<T>;
    cancel: (reason: string) => void;
  },
): Promise<T> {
  const s = support(ui.mcp);
  if (!s) {
    if (opts.url && !opts.opened) openBrowser(opts.url);
    return await opts.done;
  }

  const dismissed = (action: string): never => {
    opts.cancel("Cancelled by the user");
    leave(action);
  };

  let message = opts.message;
  if (opts.url) {
    if (!opts.opened) openBrowser(opts.url);
    message += `\nIf your browser didn't open, visit: ${opts.url}`;
  }

  // Nothing to fill in: it closes by itself, and Accept says it's done.
  const waited = await race(ui, {
    message,
    requestedSchema: { type: "object", properties: {} },
  }, opts.done);
  if (waited.landed) return waited.value;
  if (waited.action !== "accept") dismissed(waited.action);

  // The user says it's done: give it a moment to land.
  return await withTimeout(
    opts.done,
    60_000,
    "Confirmed, but nothing arrived — try again",
  );
}

/**
 * Check every few seconds until `check` returns a value; rejects when the
 * signal aborts or time runs out.
 */
export function poll<T>(
  check: () => Promise<T | undefined>,
  signal: AbortSignal,
  timeoutMs: number,
  everyMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<T>((resolve, reject) => {
    const tick = async () => {
      if (signal.aborted) return reject(new Error("Cancelled"));
      if (Date.now() > deadline) return reject(new Error("Timed out"));
      try {
        const value = await check();
        if (value !== undefined) return resolve(value);
      } catch (err) {
        return reject(err);
      }
      setTimeout(tick, everyMs);
    };
    tick();
  });
}
