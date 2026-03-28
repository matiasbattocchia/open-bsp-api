/**
 * Unified configuration for the OpenBSP plugin.
 *
 * Priority: env vars > config.json > hardcoded defaults.
 * Production defaults (Supabase URL + anon key) are baked in — these are
 * public values already embedded in the UI bundle. Zero-config for hosted users.
 */

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────

export const STATE_DIR =
  Deno.env.get("OPENBSP_STATE_DIR") ??
  join(homedir(), ".claude", "channels", "openbsp");

export const CONFIG_FILE = join(STATE_DIR, "config.json");
export const SESSION_FILE = join(STATE_DIR, "session.json");

// Production defaults — same as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// in open-bsp-ui. These are public (embedded in the SPA bundle).
const DEFAULT_SUPABASE_URL = "https://nheelwshzbgenpavwhcy.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_jS_LQSbttNz2nRyAcjOVUw_J1KpXhUd";

// ── Types ────────────────────────────────────────────────────────────────

export type Config = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  orgId?: string;
  accountPhone?: string;
  allowedContacts: string[];
};

type ConfigFile = {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  orgId?: string;
  accountPhone?: string;
  allowedContacts?: string[];
};

// ── Load / Save ──────────────────────────────────────────────────────────

function readConfigFile(): ConfigFile {
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
    supabaseUrl:
      Deno.env.get("SUPABASE_URL") ??
      file.supabaseUrl ??
      DEFAULT_SUPABASE_URL,
    supabaseAnonKey:
      Deno.env.get("SUPABASE_ANON_KEY") ??
      file.supabaseAnonKey ??
      DEFAULT_SUPABASE_ANON_KEY,
    orgId:
      Deno.env.get("ORG_ID") ?? file.orgId ?? undefined,
    accountPhone:
      Deno.env.get("ACCOUNT_PHONE") ?? file.accountPhone ?? undefined,
    allowedContacts: file.allowedContacts ?? [],
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
