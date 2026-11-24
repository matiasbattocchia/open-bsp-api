import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

const SETUP = "mcp__plugin_openbsp_openbsp__setup";
const REPLY = "mcp__plugin_openbsp_openbsp__reply";
const QUERY = "mcp__plugin_openbsp_openbsp__query";
const STATE = "/home/u/.claude/plugins/data/openbsp-openbsp";
const SETTINGS = "/home/u/.claude/settings.json";
const COMPOSE = {
  model: "claude-x",
  promptModel: "claude-x",
  surfaces: [],
  tools: [],
  outputStyle: null,
  traits: [],
};

const settings = (permission: string) =>
  JSON.stringify({
    pluginConfigs: { "openbsp@openbsp": { options: { permission } } },
  });

const START = { cwd: "/", surface: "terminal" as const, isInteractive: true };

const answer = (text: string) => ({
  value: { content: [{ type: "text", text }], isError: false },
});

/**
 * Claude Code beneath the plugin: files, a store, its own verdicts, and the
 * MCP server (the handshake, and `setup` answered by `server`). Returns the
 * server's calls.
 */
function engine(
  on: On,
  files: Record<string, string> = {},
  store: Record<string, unknown> = {},
  server: (args: Record<string, unknown>) => string = () => "",
) {
  const calls: [string, Record<string, unknown>][] = [];
  mock.store(on, store);
  on("tool.check", () => ({ decision: "allow" }));
  on("config.set", (_, e) => ({ value: e.value }));
  on("classic.ConfigChange", () => ({}));
  on("prompt.compose", () => ({
    sections: [{ id: "intro", text: "You are Claude.", scope: "shared" }],
  }));
  on("fs.exists", (_, e) => ({ value: e.path in files }));
  on("fs.read", (_, e) => {
    const text = files[e.path];
    if (text === undefined) throw new Error("ENOENT");
    return { value: text };
  });
  on("ui.log", () => ({ value: undefined }));
  on("mcp.connect", () => ({
    value: { isConnected: true, server: "plugin:openbsp:openbsp" },
  }));
  on("mcp.call", (_, e) => {
    calls.push([e.tool, e.args]);
    return answer(
      e.tool === "hooks"
        ? JSON.stringify({ stateDir: STATE, guarded: true })
        : server(e.args),
    );
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  return calls;
}

const reply = { tool: REPLY, input: { conversation_id: "c1", text: "Hi!" } };

test(
  "read only refuses a reply",
  { options: { permission: "read" } },
  async ($, on) => {
    engine(on);
    const verdict = await $.tool.check(reply);
    expect(verdict.decision).toBe("deny");
  },
);

test(
  "ask puts each reply to the user",
  { options: { permission: "ask" } },
  async ($, on) => {
    engine(on);
    const verdict = await $.tool.check(reply);
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason).toContain("asks before each message");
  },
);

test("allow leaves a reply to Claude Code's own rules", {
  options: { permission: "allow" },
}, async ($, on) => {
  engine(on);
  expect((await $.tool.check(reply)).decision).toBe("allow");
});

test("a query that reads passes; one that writes asks", {
  options: { permission: "ask" },
}, async ($, on) => {
  engine(on);
  const read = await $.tool.check({
    tool: QUERY,
    input: { path: "/rest/v1/conversations" },
  });
  const write = await $.tool.check({
    tool: QUERY,
    input: { method: "post", path: "/rest/v1/contacts" },
  });
  expect(read.decision).toBe("allow");
  expect(write.decision).toBe("ask");
});

test("a settings edit outside /config can't loosen the mode", {
  options: { permission: "ask" },
}, async ($, on) => {
  engine(on, { [SETTINGS]: settings("allow") });
  const change = await $.classic.ConfigChange({
    source: "user_settings",
    file_path: SETTINGS,
  });
  expect(change.block).toBeDefined();
  expect((await $.tool.check(reply)).decision).toBe("ask");
});

test("the next session keeps the mode from before the outside edit", {
  options: { permission: "allow" },
}, async ($, on) => {
  engine(on, {}, { outsideEdit: { value: "allow", keep: "ask" } });
  expect((await $.tool.check(reply)).decision).toBe("ask");
  const { sections } = await $.prompt.compose(COMPOSE);
  expect(sections.at(-1)?.text).toContain("Settings say allow");
});

test("an outside edit that tightens the mode goes through", {
  options: { permission: "allow" },
}, async ($, on) => {
  engine(on, { [SETTINGS]: settings("read") });
  const change = await $.classic.ConfigChange({
    source: "user_settings",
    file_path: SETTINGS,
  });
  expect(change.block).toBeUndefined();
});

const change = (value: string, origin: "composer" | "plugin") => ({
  key: "openbsp.permission",
  value,
  previous: "ask",
  provider: { plugin: "openbsp", tier: "user" as const },
  origin: origin === "composer"
    ? { kind: "composer" as const }
    : { kind: "plugin" as const, name: "other" },
});

test("another plugin can tighten the mode, not loosen it", {
  options: { permission: "ask" },
}, async ($, on) => {
  engine(on);
  expect((await $.config.set(change("allow", "plugin"))).deny).toBeDefined();
  expect((await $.config.set(change("read", "plugin"))).value).toBe("read");
});

test("the user loosens it in /config", {
  options: { permission: "ask" },
}, async ($, on) => {
  engine(on, {}, { outsideEdit: { value: "allow", keep: "ask" } });
  expect((await $.config.set(change("allow", "composer"))).value).toBe("allow");
});

test("setup asks the server's questions in the picker", async ($, on) => {
  const calls = engine(on, {}, {}, (args) =>
    JSON.stringify(
      args.answer ? { summary: "Signed in as a@b.c." } : {
        step: "organization",
        ask: {
          header: "Sign in",
          question: "Sign in with?",
          options: ["Google", "GitHub"],
        },
      },
    ));
  on("tool.call", { tool: "AskUserQuestion" }, (_, e) => ({
    result: {
      questions: e.questions,
      answers: { [e.questions[0]?.question ?? ""]: "GitHub" },
    },
  }));
  on("tool.call", { tool: SETUP }, () => ({ result: "the server answered" }));

  const { result } = await $.tool.call({ tool: SETUP });
  expect(result).toBe("Signed in as a@b.c.");
  expect(calls).toEqual([["setup", {}], ["setup", { answer: "GitHub" }]]);
});

test("closing the picker stops the setup at its step", async ($, on) => {
  engine(on, {}, {}, () =>
    JSON.stringify({
      step: "accounts",
      ask: { header: "Accounts", question: "Connect?", options: ["A", "B"] },
    }));
  on("tool.call", { tool: "AskUserQuestion" }, () => ({ deny: "closed" }));

  const { result } = await $.tool.call({ tool: SETUP, step: "accounts" });
  expect(result).toContain("at the accounts step");
});

test("Claude hears it isn't set up, until it is", async ($, on) => {
  engine(on);
  await $.session.start(START);
  const { sections } = await $.prompt.compose(COMPOSE);
  expect(sections.at(-1)?.text).toContain("isn't set up yet");
});

test("once signed in, Claude hears how often to check", async ($, on) => {
  engine(on, {
    [`${STATE}/session.json`]: "{}",
    [`${STATE}/config.json`]: JSON.stringify({ checkEvery: "10m" }),
  });
  await $.session.start(START);
  const { sections } = await $.prompt.compose(COMPOSE);
  const text = sections.at(-1)?.text ?? "";
  expect(text).not.toContain("isn't set up yet");
  expect(text).toContain("every 10m");
  expect(text).toContain("Permission mode: ask");
});

test("the session starts with the handshake", async ($, on) => {
  const calls = engine(on);
  await $.session.start(START);
  expect(calls).toEqual([["hooks", {}]]);
});

test("before the handshake, Claude hears only the mode", async ($, on) => {
  engine(on);
  const { sections } = await $.prompt.compose(COMPOSE);
  expect(sections.at(-1)?.text).not.toContain("isn't set up yet");
});

test("Claude can't make the handshake itself", async ($, on) => {
  engine(on);
  const verdict = await $.tool.check({
    tool: "mcp__plugin_openbsp_openbsp__hooks",
    input: {},
  });
  expect(verdict.decision).toBe("deny");
});
