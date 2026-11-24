/**
 * The plugin's hooks module (a Claude Code mod): what the MCP server can't do
 * from its own process.
 *
 * - The permission mode, set in /config (`userConfig.permission`): each send
 *   or change goes to the user in Claude Code's own approval dialog, or is
 *   refused, with the mode as it stands now. A settings file edited outside
 *   /config (by hand, or by a tool Claude ran) can't loosen it.
 * - Setup: when Claude calls the setup tool, its questions go straight to the
 *   user in the picker, with no model between them; Claude gets the summary.
 * - What Claude should know: the mode, that OpenBSP isn't set up yet, how
 *   often the user wants their messages checked.
 *
 * It runs without Node: everything outside it goes through `$`.
 */

import type { EngineInterface, Register } from "claude-code";
import {
  isChange,
  looser,
  parsePermission,
  type Permission,
  PERMISSION_NOTES,
} from "../modes.ts";

const TOOLS = "mcp__plugin_openbsp_openbsp__";

const NUDGE =
  "OpenBSP isn't set up yet. Once in this session (at the end of your next reply, if you haven't yet), offer in one line to set it up; when the user agrees, call the openbsp setup tool.";

/**
 * A settings edit outside /config that would have loosened the mode: refused
 * for the session, and remembered, since the file keeps it.
 */
type OutsideEdit = { value: Permission; keep: Permission };

/** The mode in force: the one set, unless it was set outside /config. */
async function currentMode(
  $: EngineInterface,
  option: unknown,
): Promise<Permission> {
  const set = parsePermission(option);
  const outside = await $.store.get("outsideEdit") as OutsideEdit | undefined;
  return outside?.value === set ? outside.keep : set;
}

/** The mode a settings file holds for this plugin, if any. */
function storedMode(text: string): Permission | undefined {
  try {
    const configs = JSON.parse(text)?.pluginConfigs ?? {};
    for (const [key, config] of Object.entries(configs)) {
      if (key.split("@")[0] !== "openbsp") continue;
      const value = (config as { options?: { permission?: unknown } })
        ?.options?.permission;
      if (value !== undefined) return parsePermission(value);
    }
  } catch { /* not JSON */ }
  return undefined;
}

/** What the server's folder says: not set up yet, or how often to check. */
async function signedInLines(
  $: EngineInterface,
  dir: string,
): Promise<string[]> {
  if (!(await $.fs.exists(`${dir}/session.json`))) return [NUDGE];
  let every: unknown;
  try {
    every = JSON.parse(await $.fs.read(`${dir}/config.json`))?.checkEvery;
  } catch { /* none yet, or unreadable: no checking */ }
  return typeof every === "string"
    ? [
      `OpenBSP: the user chose to have their messages checked every ${every}. A loop doesn't outlive a session: when they ask about their messages or to start checking, run the loop skill with \`${every} /openbsp:inbox\`.`,
    ]
    : [];
}

/** One answer of the setup tool, as the server words it for this module. */
type SetupTurn = {
  step?: string;
  ask?: { header: string; question: string; options: string[] };
  summary?: string;
};

async function setupCall(
  $: EngineInterface,
  args: Record<string, string>,
): Promise<SetupTurn> {
  const server = await $.mcp.connect("openbsp");
  if (!server.isConnected) return { summary: server.message };
  const { content, isError } = await $.mcp.call(server.server, "setup", args);
  const text = content.map((block) => block.text ?? "").join("");
  if (isError) return { summary: text };
  try {
    return JSON.parse(text) as SetupTurn;
  } catch {
    // A server started before this module: its question is for Claude.
    return { summary: text };
  }
}

export const register: Register = (on, options) => {
  // The server's folder (the sign-in, setup's answers), from the handshake.
  let stateDir: string | undefined;

  on("session.start", async ($, e, next) => {
    const set = parsePermission(options.permission);
    const now = await currentMode($, options.permission);
    if (now !== set) {
      $.ui.log(
        `The OpenBSP permission mode was changed to ${set} outside /config; it stays ${now} until it's set in /config.`,
      );
    }
    const result = await next(e);
    // The server's first tool call: from now on it leaves the mode to us.
    // Failing, the server keeps asking itself, in a dialog of its own.
    try {
      const server = await $.mcp.connect("openbsp");
      if (server.isConnected) {
        const { content } = await $.mcp.call(server.server, "hooks");
        stateDir = JSON.parse(content[0]?.text ?? "{}").stateDir;
      }
    } catch (err) {
      $.ui.log(`openbsp: no handshake with the server: ${err}`, {
        to: "debug",
      });
    }
    return result;
  });

  // The handshake is this module's alone.
  on(
    "tool.describe",
    { tool: "mcp__plugin_openbsp_openbsp__hooks" },
    (_$, e, next) => next({ ...e, isDeferred: true }),
  );

  // Each send or change, with the mode as it stands now.
  on("tool.check", async ($, e, next) => {
    if (!e.tool.startsWith(TOOLS)) return next(e);
    const name = e.tool.slice(TOOLS.length);
    if (name === "hooks") {
      return next.origin.plugin.split("@")[0] === "openbsp" ? next(e) : {
        decision: "deny",
        reason: "Only Claude Code's hooks module calls this.",
      };
    }
    const input = (e.input ?? {}) as { method?: string; path?: string };
    const changes = name === "reply" ||
      (name === "query" &&
        isChange((input.method ?? "GET").toUpperCase(), input.path ?? ""));
    if (!changes) return next(e);

    const now = await currentMode($, options.permission);
    if (now === "allow") return next(e);
    if (now === "read") {
      return {
        decision: "deny",
        reason:
          "The user's OpenBSP permission mode is read only: show them the draft instead. They change the mode in /config.",
      };
    }
    return {
      decision: "ask",
      decider: "person",
      reason: name === "reply"
        ? "Your OpenBSP permission mode asks before each message Claude sends."
        : "Your OpenBSP permission mode asks before each change Claude makes.",
    };
  }).catch(() => ({
    decision: "deny",
    reason: "The OpenBSP permission guard failed.",
  }));

  // Only the user, in /config, loosens the mode.
  on("config.set", { key: "openbsp.permission" }, async ($, e, next) => {
    const now = await currentMode($, options.permission);
    if (
      e.origin?.kind !== "composer" && looser(parsePermission(e.value), now)
    ) {
      return {
        deny:
          "Only the user, in /config, can loosen the OpenBSP permission mode.",
      };
    }
    const result = await next(e);
    if (result.deny === undefined) await $.store.delete("outsideEdit");
    return result;
  }).catch((_$, e, next) =>
    next.called ? next(e) : { deny: "The OpenBSP permission guard failed." }
  );

  // A settings file changed outside /config (which raises no such event).
  on("classic.ConfigChange", async ($, e, next) => {
    if (!e.file_path) return next(e);
    const value = storedMode(await $.fs.read(e.file_path).catch(() => ""));
    const set = parsePermission(options.permission);
    const keep = await currentMode($, options.permission);
    if (value === undefined || value === set || !looser(value, keep)) {
      return next(e);
    }
    await $.store.set("outsideEdit", { value, keep });
    $.ui.log(
      `The OpenBSP permission mode was changed to ${value} outside /config; it stays ${keep}. Only /config changes it.`,
    );
    return { block: "The OpenBSP permission mode changes only in /config." };
  });

  // Setup: the server's questions, asked here in the picker.
  on(
    "tool.call",
    { tool: "mcp__plugin_openbsp_openbsp__setup" },
    async ($, e) => {
      const { step } = e as { step?: string };
      let turn = await setupCall($, step ? { step } : {});
      while (turn.ask) {
        let answer: string;
        try {
          answer = await $.ui.ask(turn.ask.question, {
            header: turn.ask.header,
            options: turn.ask.options,
          });
        } catch {
          return {
            result:
              `The user closed the setup at the ${turn.step} step. Don't ask its questions yourself: when they want to go on, call setup again with step "${turn.step}".`,
          };
        }
        turn = await setupCall($, { answer });
      }
      return { result: turn.summary ?? "" };
    },
  );

  // What Claude should know about OpenBSP, as it stands at each request.
  on("prompt.compose", async ($, e, next) => {
    const result = await next(e);
    const set = parsePermission(options.permission);
    const now = await currentMode($, options.permission);
    const lines = [
      `OpenBSP ${PERMISSION_NOTES[now]} The user sets it in /config.${
        now === set
          ? ""
          : ` (Settings say ${set}, but that was changed outside /config, so it doesn't count.)`
      }`,
    ];

    if (stateDir !== undefined) lines.push(...await signedInLines($, stateDir));

    return {
      sections: [...result.sections, {
        id: "openbsp:state",
        text: lines.join("\n"),
        scope: "session",
      }],
    };
  });
};
