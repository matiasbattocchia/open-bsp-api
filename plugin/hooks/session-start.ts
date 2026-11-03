/**
 * SessionStart: what Claude should know about OpenBSP when a session starts.
 * Whatever this prints is added to Claude's context.
 *
 * - Never set up: offer /openbsp:setup, once.
 * - Checking every N: start the inbox loop when the user brings up messages.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, SESSION_FILE, STATE_DIR } from "../config.ts";

const OFFERED = join(STATE_DIR, "setup-offered");

if (!existsSync(SESSION_FILE)) {
  if (!existsSync(OFFERED)) {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(OFFERED, new Date().toISOString() + "\n");
    console.log(
      "The OpenBSP plugin was just installed and isn't set up. In one line at your first reply, tell the user that /openbsp:setup signs them in, connects WhatsApp, Instagram or TikTok, and has Claude read and answer their messages.",
    );
  }
} else {
  const { checkEvery } = loadConfig();
  if (checkEvery) {
    console.log(
      `OpenBSP: the user chose to have their messages checked every ${checkEvery}. A loop doesn't outlive a session: when they ask about their messages or to start checking, run the loop skill with \`${checkEvery} /openbsp:inbox\`.`,
    );
  }
}
