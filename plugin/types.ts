/**
 * Types copied from supabase/functions/_shared/types/
 *
 * These are the subset of OpenBSP types needed by the plugin server.
 * Kept as a standalone copy because the source files have deep dependency
 * chains (db_types.ts, a2a_types.ts, type-fest, etc.) that don't resolve
 * outside the edge functions context.
 */

// ── Services ────────────────────────────────────────────────────────────

export type Service =
  | "whatsapp"
  | "instagram"
  | "local"
  | "slack"
  | "discord"
  | "teams"
  | "whatsapp-web"
  | "tiktok";

// ── Content parts ───────────────────────────────────────────────────────

export type TextPart = {
  type: "text";
  kind: "text" | "reaction" | "caption" | "transcription" | "description";
  text: string;
  artifacts?: Part[];
};

export type FilePart = {
  type: "file";
  kind: string; // audio, image, video, document, sticker; Instagram adds more
  file: {
    mime_type: string;
    uri: string;
    name?: string;
    size?: number;
  };
  text?: string; // caption
  artifacts?: Part[];
};

// kind: location, contacts, reaction, share, poll, template, … — `data`
// depends on it.
export type DataPart = {
  type: "data";
  kind: string;
  data: unknown;
  text?: string;
  artifacts?: Part[];
};

export type Part = TextPart | DataPart | FilePart;

// ── Message content ─────────────────────────────────────────────────────

export type MessageContent =
  & {
    version: "1";
    re_message_id?: string; // replied, reacted or forwarded message id
    forwarded?: boolean;
    internal?: true; // record-only: never dispatched, not conversation
  }
  & Part;

// ── Row types (as they arrive from Supabase Realtime) ───────────────────

// The addressing is two columns: conversation_address is the peer the
// conversation is with (an individual, a group or a channel); sender_address
// is the contact who authored the message, null when the account itself
// spoke (sends, echoes, internal).
export type MessageRow = {
  id: string;
  organization_id: string;
  conversation_id: string;
  service: Service;
  organization_address: string;
  conversation_address: string | null;
  sender_address: string | null;
  thread_id: string | null;
  agent_id: string | null;
  external_id: string | null;
  content: MessageContent;
  status: Record<string, unknown>;
  timestamp: string;
  created_at: string;
  updated_at: string;
};

export type ConversationRow = {
  id: string;
  organization_id: string;
  service: Service;
  organization_address: string;
  address: string;
  name: string | null;
  type: "direct" | "group" | "channel" | "broadcast" | null;
  extra: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

// ── Insert types (for creating outgoing messages) ───────────────────────

export type OutgoingMessageInsert = {
  organization_id: string;
  conversation_id: string;
  service: Service;
  organization_address: string;
  conversation_address: string;
  sender_address: null;
  thread_id?: string;
  agent_id: string;
  content: MessageContent;
};
