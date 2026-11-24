/**
 * Unified configuration for the OpenBSP plugin.
 *
 * The backend is production's, baked in — public values already embedded in
 * the UI bundle, so hosted users configure nothing; env vars point it
 * elsewhere (self-hosting, a local stack). config.json holds setup's answers.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";

// ── Constants ────────────────────────────────────────────────────────────

// Claude Code's folder for the plugin's data: kept across updates, removed
// on uninstall. Run outside Claude Code (CI, by hand), a folder of its own.
export const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA ??
  join(homedir(), ".openbsp");

export const CONFIG_FILE = join(STATE_DIR, "config.json");
export const SESSION_FILE = join(STATE_DIR, "session.json");
export const INBOX_FILE = join(STATE_DIR, "inbox.json");

// Where versions up to 0.7 kept the same files.
const OLD_STATE_DIR = join(homedir(), ".claude", "channels", "openbsp");

/**
 * Brings the sign-in, setup's answers and the inbox's place from where an
 * earlier version kept them, once: into a folder that holds none yet.
 */
export function moveOldState(): void {
  // Only under Claude Code: run by hand, the server leaves them be.
  if (!process.env.CLAUDE_PLUGIN_DATA || !existsSync(OLD_STATE_DIR)) return;
  if (existsSync(SESSION_FILE) || existsSync(CONFIG_FILE)) return;
  // A working copy loaded with --plugin-dir (openbsp@inline) leaves them to
  // the installed plugin.
  if (basename(STATE_DIR).endsWith("-inline")) return;

  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  for (const file of [SESSION_FILE, CONFIG_FILE, INBOX_FILE]) {
    const old = join(OLD_STATE_DIR, basename(file));
    if (!existsSync(old)) continue;
    try {
      renameSync(old, file);
    } catch {
      // Another file system: copy, then remove (a session lives in one place).
      copyFileSync(old, file);
      rmSync(old);
    }
  }
  // What else 0.6 left there; the folder goes once empty.
  rmSync(join(OLD_STATE_DIR, "setup-offered"), { force: true });
  try {
    rmdirSync(OLD_STATE_DIR);
  } catch { /* not empty: not ours to remove */ }
}

// Production defaults — same as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// in open-bsp-ui. These are public (embedded in the SPA bundle).
const DEFAULT_SUPABASE_URL = "https://nheelwshzbgenpavwhcy.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "sb_publishable_jS_LQSbttNz2nRyAcjOVUw_J1KpXhUd";
// The OpenBSP app, where the onboarding links open.
const DEFAULT_APP_URL = "https://web.openbsp.dev";

// ── Types ────────────────────────────────────────────────────────────────

export type Config = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  appUrl: string;
  orgId?: string;
  allowedContacts: string[];
  checkEvery?: string; // a /loop interval (5m, 1h); absent = on request
};

export type ConfigFile = {
  orgId?: string;
  allowedContacts?: string[];
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

/** The backend (env vars, else production) and setup's answers. */
export function loadConfig(): Config {
  const file = readConfigFile();

  return {
    supabaseUrl: process.env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? DEFAULT_SUPABASE_ANON_KEY,
    appUrl: process.env.OPENBSP_APP_URL ?? DEFAULT_APP_URL,
    orgId: file.orgId,
    allowedContacts: file.allowedContacts ?? [],
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
  renameSync(tmp, CONFIG_FILE);
}

/** Merge into config.json, keeping every other key. */
export function updateConfig(patch: ConfigFile): void {
  saveConfig({ ...readConfigFile(), ...patch });
}
