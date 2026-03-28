/**
 * Types copied from supabase/functions/_shared/supabase.ts
 *
 * These are the subset of OpenBSP types needed by the plugin server.
 * Kept as a standalone copy because the source file has deep dependency
 * chains (db_types.ts, a2a_types.ts, type-fest, etc.) that don't resolve
 * outside the edge functions context.
 */

// ── Content parts ───────────────────────────────────────────────────────

export type TextPart = {
  type: "text";
  kind: "text" | "reaction" | "caption" | "transcription" | "description";
  text: string;
  artifacts?: Part[];
};

export type FilePart = {
  type: "file";
  kind: "audio" | "image" | "video" | "document" | "sticker";
  file: {
    mime_type: string;
    uri: string;
    name?: string;
    size: number;
  };
  text?: string; // caption
  artifacts?: Part[];
};

export type DataPart = {
  type: "data";
  kind: string;
  data: unknown;
  artifacts?: Part[];
};

export type Part = TextPart | DataPart | FilePart;

// ── Message content types ───────────────────────────────────────────────

type TaskInfo = {
  task?: {
    id: string;
    status?: string;
    session_id?: string;
  };
};

export type IncomingMessage = {
  version: "1";
  re_message_id?: string;
  forwarded?: boolean;
  referred_product?: {
    catalog_id: string;
    product_retailer_id: string;
  };
} & TaskInfo &
  (TextPart | FilePart | DataPart);

export type OutgoingMessage = {
  version: "1";
  re_message_id?: string;
  forwarded?: boolean;
} & TaskInfo &
  (TextPart | FilePart | DataPart);

// ── Status types ────────────────────────────────────────────────────────

export type IncomingStatus = {
  pending?: string;
  read?: string;
  typing?: string;
  preprocessing?: string;
  preprocessed?: string;
};

export type OutgoingStatus = {
  pending?: string;
  held_for_quality_assessment?: string;
  accepted?: string;
  sent?: string;
  delivered?: string;
  read?: string;
  failed?: string;
  errors?: Record<string, unknown>[];
};

// ── Row types (as they arrive from Supabase Realtime) ───────────────────

type MessageRowBase = {
  id: string;
  organization_id: string;
  conversation_id: string;
  service: string;
  organization_address: string;
  contact_address: string;
  agent_id: string | null;
  timestamp: string;
  created_at: string;
  updated_at: string;
};

export type MessageRow = MessageRowBase &
  (
    | {
        direction: "incoming";
        content: IncomingMessage;
        status: IncomingStatus;
      }
    | {
        direction: "internal";
        content: IncomingMessage; // simplified — internal uses similar shape
        status: IncomingStatus;
      }
    | {
        direction: "outgoing";
        content: OutgoingMessage;
        status: OutgoingStatus;
      }
  );

export type ConversationRow = {
  id: string;
  organization_id: string;
  service: string;
  organization_address: string;
  contact_address: string;
  created_at: string;
  updated_at: string;
  extra: Record<string, unknown> | null;
};

// ── Insert types (for creating outgoing messages) ───────────────────────

export type OutgoingMessageInsert = {
  organization_id: string;
  organization_address: string;
  contact_address: string;
  service: string;
  direction: "outgoing";
  content: OutgoingMessage;
};
