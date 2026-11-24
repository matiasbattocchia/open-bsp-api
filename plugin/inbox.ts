/**
 * The inbox: what people wrote since the last check, and how the user wants
 * Claude to handle it. What /openbsp:inbox (and /loop) reads. The reading is
 * the remote MCP server's too (supabase/functions/_shared/inbox.ts); the
 * place it left off is kept on this computer, per organization.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { INBOX_FILE, STATE_DIR } from "./config.ts";
import { modeNote } from "./permission.ts";
import {
  type Accounts,
  FIRST_LOOK_BACK_MS,
  readConversation,
  readInbox as read,
} from "../supabase/functions/_shared/inbox.ts";
import type { Org } from "./org.ts";

// The cursor: created_at of the last message read, per organization.
type Cursor = Record<string, string>;

function readCursor(): Cursor {
  try {
    return JSON.parse(readFileSync(INBOX_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCursor(cursor: Cursor): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(INBOX_FILE, JSON.stringify(cursor, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** What arrived since the last check; or one conversation, opened. */
export async function readInbox(
  supabase: SupabaseClient,
  org: Org,
  accounts: Accounts,
  conversationId?: string,
): Promise<string> {
  const reader = { orgId: org.orgId, agentId: org.agentId, accounts };
  if (conversationId) {
    return await readConversation(supabase, reader, conversationId);
  }

  const cursor = readCursor();
  const note = modeNote();
  const { text, cursor: next } = await read(supabase, reader, {
    since: cursor[org.orgId] ??
      new Date(Date.now() - FIRST_LOOK_BACK_MS).toISOString(),
    notes: note ? [note] : [],
  });
  if (next) saveCursor({ ...cursor, [org.orgId]: next });
  return text;
}
