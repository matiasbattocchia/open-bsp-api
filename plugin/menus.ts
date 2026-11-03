/**
 * Menus and dialogs in the Claude Code TUI, through MCP elicitation.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { openBrowser } from "./auth.ts";

export type Choice = { value: string; title: string };

/** Where dialogs show; aborting the signal (the tool call's) retracts them. */
export type Ui = { mcp: Server; signal?: AbortSignal };

type Field =
  | { type: "string"; title: string; description?: string; default?: string }
  | {
    type: "string";
    title: string;
    description?: string;
    default?: string;
    oneOf: { const: string; title: string }[];
  }
  | { type: "boolean"; title: string; description?: string };

type Support = { form?: object; url?: object };

function support(mcp: Server): Support | undefined {
  return mcp.getClientCapabilities()?.elicitation as Support | undefined;
}

const signals = (ui: Ui, own: AbortSignal) =>
  ui.signal ? AbortSignal.any([own, ui.signal]) : own;

/** Whether the client shows forms; an empty declaration means forms. */
export function canShowMenus(mcp: Server): boolean {
  const s = support(mcp);
  return !!s && (!!s.form || !s.url);
}

/** A form; null when the user dismisses it. */
export async function form(
  ui: Ui,
  message: string,
  properties: Record<string, Field>,
  required: string[] = [],
): Promise<Record<string, string | boolean> | null> {
  const res = await ui.mcp.elicitInput({
    message,
    requestedSchema: { type: "object", properties, required },
  }, { signal: ui.signal });
  if (res.action !== "accept") return null;
  return (res.content ?? {}) as Record<string, string | boolean>;
}

/**
 * A menu: the value the user picks; null when they dismiss it. With a
 * `preselected` value, Accept alone takes it.
 */
export async function choose(
  ui: Ui,
  message: string,
  choices: Choice[],
  { title = "Choose", preselected }: { title?: string; preselected?: string } =
    {},
): Promise<string | null> {
  const answer = await form(ui, message, {
    choice: {
      type: "string",
      title,
      oneOf: choices.map((c) => ({ const: c.value, title: c.title })),
      ...(preselected ? { default: preselected } : {}),
    },
  }, ["choice"]);
  return (answer?.choice as string | undefined) ?? null;
}

/** One line of text; null when dismissed or left empty. */
export async function ask(
  ui: Ui,
  message: string,
  field: { title: string; description?: string; default?: string },
): Promise<string | null> {
  const answer = await form(ui, message, {
    value: { type: "string", ...field },
  }, ["value"]);
  const value = (answer?.value as string | undefined)?.trim();
  return value || null;
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
  })
    .then((res) => {
      open = false;
      return { landed: false as const, action: res.action };
    });
  answered.catch(() => {}); // the losing branch must not go unhandled

  try {
    return await Promise.race([
      done.then((value) => {
        // A URL dialog is dismissed by notification, per MCP spec.
        if ("mode" in params && params.mode === "url") {
          ui.mcp
            .notification({
              method: "notifications/elicitation/complete",
              params: { elicitationId: params.elicitationId },
            })
            .catch(() => {});
        }
        return { landed: true as const, value };
      }),
      answered,
    ]);
  } finally {
    if (open) ac.abort(); // retract it
  }
}

/**
 * Keep a dialog open while the user does something elsewhere — signs in or
 * connects an account in the browser, types a code on their phone — and
 * close it as soon as `done` lands. A `url` not `opened` yet is offered in a
 * URL dialog when the client takes them, which only opens it: a waiting
 * dialog follows. Otherwise this process opens it (unless `opened`) and the
 * waiting dialog shows it. Dismissing a dialog calls `cancel` and rejects.
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

  const dismissed = (): never => {
    opts.cancel("Cancelled by the user");
    throw new Error("Cancelled by the user");
  };

  let message = opts.message;
  if (opts.url && s.url && !opts.opened) {
    const opened = await race(ui, {
      mode: "url",
      elicitationId: crypto.randomUUID(),
      url: opts.url,
      message: opts.message,
    }, opts.done);
    if (opened.landed) return opened.value;
    if (opened.action !== "accept") dismissed();
    message += `\nThe page: ${opts.url}`;
  } else if (opts.url) {
    if (!opts.opened) openBrowser(opts.url);
    message += `\nIf your browser didn't open, visit: ${opts.url}`;
  }

  const waited = await race(ui, {
    message,
    requestedSchema: {
      type: "object",
      properties: {
        done: {
          type: "boolean",
          title: "Done",
          description: "This closes by itself once it's done.",
        },
      },
    },
  }, opts.done);
  if (waited.landed) return waited.value;
  if (waited.action !== "accept") dismissed();

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
