/**
 * Unified configuration for the OpenBSP plugin.
 *
 * Priority: env vars > config.json > hardcoded defaults.
 * Production defaults (Supabase URL + anon key) are baked in — these are
 * public values already embedded in the UI bundle. Zero-config for hosted users.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────

// HOME rather than os.homedir(), which needs --allow-sys on top of --allow-env.
export const STATE_DIR = Deno.env.get("OPENBSP_STATE_DIR") ??
  join(
    Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".",
    ".claude",
    "channels",
    "openbsp",
  );

export const CONFIG_FILE = join(STATE_DIR, "config.json");
export const SESSION_FILE = join(STATE_DIR, "session.json");
export const INBOX_FILE = join(STATE_DIR, "inbox.json");

// Production defaults — same as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// in open-bsp-ui. These are public (embedded in the SPA bundle).
const DEFAULT_SUPABASE_URL = "https://nheelwshzbgenpavwhcy.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "sb_publishable_jS_LQSbttNz2nRyAcjOVUw_J1KpXhUd";
// The OpenBSP app, where the onboarding links open.
const DEFAULT_APP_URL = "https://web.openbsp.dev";

// ── Types ────────────────────────────────────────────────────────────────

// What Claude does with a new message: write a draft for the user to approve,
// send the answer itself, or only tell the user about it.
export type AnswerMode = "draft" | "reply" | "notify";

export type Answering = {
  mode: AnswerMode;
  instructions?: string; // tone, language, who the user is
};

export type Config = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  appUrl: string;
  orgId?: string;
  allowedContacts: string[];
  answering: Answering;
  checkEvery?: string; // a /loop interval (5m, 1h); absent = on request
};

export type ConfigFile = {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  appUrl?: string;
  orgId?: string;
  allowedContacts?: string[];
  answering?: Answering;
  checkEvery?: string;
};

// ── Load / Save ──────────────────────────────────────────────────────────

export function readConfigFile(): ConfigFile {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return {};
  }
}

/**
 * Load configuration with full priority chain:
 * env vars > config.json > hardcoded defaults.
 */
export function loadConfig(): Config {
  const file = readConfigFile();

  return {
    supabaseUrl: Deno.env.get("SUPABASE_URL") ??
      file.supabaseUrl ??
      DEFAULT_SUPABASE_URL,
    supabaseAnonKey: Deno.env.get("SUPABASE_ANON_KEY") ??
      file.supabaseAnonKey ??
      DEFAULT_SUPABASE_ANON_KEY,
    appUrl: Deno.env.get("OPENBSP_APP_URL") ?? file.appUrl ?? DEFAULT_APP_URL,
    orgId: Deno.env.get("ORG_ID") ?? file.orgId ?? undefined,
    allowedContacts: file.allowedContacts ?? [],
    answering: file.answering ?? { mode: "draft" },
    checkEvery: file.checkEvery,
  };
}

/**
 * Atomic write: tmp file + rename, 0o600 permissions.
 */
export function saveConfig(config: ConfigFile): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = CONFIG_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  Deno.renameSync(tmp, CONFIG_FILE);
}

/** Merge into config.json, keeping every other key. */
export function updateConfig(patch: ConfigFile): void {
  saveConfig({ ...readConfigFile(), ...patch });
}
