import type { Json } from "../db_types.ts";
import type {
  ButtonMessage,
  Contact,
  InteractiveMessage,
  Location,
  Order,
  UnsupportedMessage,
  WhatsAppReferral,
} from "./whatsapp_webhook_message_types.ts";
import type { Template } from "./whatsapp_template_types.ts";
import type { InstagramReferral } from "./instagram_webhook_payload_types.ts";

//===================================
// Agent Protocol Types
//===================================

// Lifecycle state of a task. Retained for historical rows; current handlers set
// only task.id.
export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "unknown";

// The same message can be a task request and a task response.
// A user message is a task request. The message produced by an agent is a task response.
// Then, for example, another agent might react to that message, creating a new task request.
// The message is now a task response and a task request.
export type TaskInfo = {
  task?: {
    id: string;
    status?: TaskState;
    session_id?: string;
  };
};

export type ToolInfo = {
  tool?:
    & ToolEventInfo
    & (LocalToolInfo | GoogleToolInfo | OpenAIToolInfo | AnthropicToolInfo);
};

export type ToolEventInfo =
  | { use_id: string; event: "use" }
  | { use_id: string; event: "result"; is_error?: boolean };

type LocalSimpleToolInfo = {
  provider: "local";
  type: "function" | "custom";
  name: string;
};

type LocalSpecialToolInfo = {
  provider: "local";
  type: "mcp" | "sql" | "http";
  label: string;
  name: string;
};

export type LocalToolInfo = LocalSimpleToolInfo | LocalSpecialToolInfo;

type GoogleToolInfo = {
  provider: "google";
  type: "google_search" | "code_execution" | "url_context";
};

type OpenAIToolInfo = {
  provider: "openai";
  type:
    | "mcp"
    | "web_search_preview"
    | "file_search"
    | "image_generation"
    | "code_interpreter"
    | "computer_use_preview";
};

type AnthropicToolInfo = {
  provider: "anthropic";
  type:
    | "mcp"
    | "bash"
    | "code_execution"
    | "computer"
    | "str_replace_based_edit_tool"
    | "web_search";
};

/**
 * A mention — who the text calls out. Dual-keyed the way authorship is:
 * `address` in contact space (a WhatsApp participant's digits, a Slack user
 * id), `agent_id` in member space; either or both may be set. `name` is the
 * display text as it appears in `text` ("@Ana" ⇒ name "Ana"), which is also
 * how dispatchers find the token to re-encode natively (Slack `<@U…>`,
 * WhatsApp `@digits` + MentionedJID). Soft references like `re_message_id`:
 * tolerant of absence, never a FK.
 */
export type Mention = {
  address?: string;
  agent_id?: string;
  name?: string;
};

// Text based

export type TextPart = {
  type: "text";
  kind: "text" | "reaction" | "caption" | "transcription" | "description";
  text: string;
  artifacts?: Part[];
};

// File based

export const MediaTypes = [
  "audio",
  "image",
  "video",
  "document",
  "sticker",
  "file", // Instagram native attachment type (e.g. pdf)
  "media", // Instagram generic media attachment
  // Instagram story attachments carry a real, downloadable CDN url, so they are
  // modeled as files (downloaded/persisted) while keeping their native kind.
  // Shared posts/reels (ig_post/ig_reel/reel) are NOT here: their url is a web
  // permalink, not media, so they are modeled as a `share` data part instead.
  "story",
  "ig_story",
  "story_mention",
  "story_reply", // synthetic: the story a user replied to (reply_to.story)
] as const;

/**
 * Represents a file, such as an image, video, or document.
 * WhatsApp allows media messages to include an accompanying text caption.
 * For now, this caption is embedded directly within the `text` attribute of the `FilePart`.
 * A more structured approach, leveraging the `Parts` type, would involve separate
 * `FilePart` and `TextPart` components for such messages in the future.
 */
export type FilePart = {
  type: "file";
  kind: (typeof MediaTypes)[number];
  file: {
    mime_type: string;
    // internal://media/organizations/${organization_id}/attachments/${hash},
    // or an external http(s) URL — those are never downloaded on our side;
    // dispatchers pass them as links for the service to fetch itself.
    uri: string;
    name?: string;
    size?: number; // unknown for external URLs
  };
  text?: string; // caption
  artifacts?: Part[];
};

// Data based

export type DataPart<Kind = "data", T = Json> = {
  type: "data";
  kind: Kind;
  data: T;
  text?: string;
  artifacts?: Part[];
};

type ContactsPart = DataPart<"contacts", Contact[]>;

type LocationPart = DataPart<"location", Location>;

type OrderPart = DataPart<"order", Order>;

type InteractivePart = DataPart<
  "interactive",
  InteractiveMessage["interactive"]
>;

type ButtonPart = DataPart<"button", ButtonMessage["button"]>;

type TemplatePart = DataPart<"template", Template>;

/**
 * A medium that arrived without its bytes: the Cloud API sends this when it
 * cannot hand the media over, and whatsapp-web sends it for media it did not
 * store (a history import, a failed download, a storage cap).
 *
 * `data` stays empty, as the Cloud API leaves it. Whatever IS known about the
 * medium goes in `file` — the field a reader already consults for a FilePart,
 * minus the `uri` that is the entire thing missing here.
 */
type MediaPlaceholderPart =
  & DataPart<"media_placeholder", Record<PropertyKey, never>>
  & { file?: Omit<FilePart["file"], "uri"> };

type UnsupportedPart = DataPart<
  "unsupported",
  UnsupportedMessage["unsupported"]
>;

// Synthetic content for messaging_referral events (no message attached).
type ReferralPart = DataPart<"referral", InstagramReferral>;

// Reactions, all services (2026-07-26 convention, data-only). One row per
// reaction event; re_message_id points at the reacted message's external id.
//
// No `text`: rendering is the UI's job (data.unicode, falling back to
// `:name:` for e.g. Slack custom emoji). `name`/`unicode` are optional only
// because Meta removal events don't say which emoji is being removed
// (unambiguous there: one reaction per user per message). Legacy rows exist
// as TextPart kind 'reaction' — read-side only.
export type ReactionPart = DataPart<"reaction", {
  action: "added" | "removed";
  /** Service-native emoji id, e.g. Slack "thumbsup", Discord custom-emoji
   * id; for Meta the Unicode emoji itself. */
  name?: string;
  /** Unicode rendering, e.g. "👍" — absent only for emoji with no Unicode
   * form (custom workspace emoji) and Meta removals. */
  unicode?: string;
}>;

// Shared Instagram post/reel (attachment types ig_post, ig_reel, reel). Unlike
// real media, the attachment `payload.url` is a public instagram.com permalink
// (an HTML page, not a downloadable CDN file), so these are modeled as data — a
// link card — and skipped by media download. `data.type` keeps the original
// attachment type so consumers can label it (post vs reel); `url` is the
// permalink and `title` the shared item's caption when provided.
export type SharePart = DataPart<"share", {
  type: "ig_post" | "ig_reel" | "reel";
  url: string;
  title?: string;
}>;

// Multi-part messages

export type Part =
  | TextPart
  | DataPart
  | FilePart
  | SharePart;

// Parts type is not used yet. It is a proof of concept.
export type Parts = {
  type: "parts";
  kind: "parts";
  parts: Part[];
  artifacts?: Part[];
};

/**
 * WhatsApp Messages
 * Text (caption for media types)
 * Media (File)
 * Data
 *
 * Text and/or Media (up to two parts), or Data (one part)
 *
 * Excepting Reaction, Contacts and Location, all other types differ depending on the direction (incoming or outgoing)
 */

export type IncomingMessage =
  & {
    version: "1";
    re_message_id?: string; // replied, reacted or forwarded message id
    forwarded?: boolean;
    mentions?: Mention[];
    referred_product?: {
      catalog_id: string;
      product_retailer_id: string;
    };
    referral?: WhatsAppReferral | InstagramReferral;
  }
  & TaskInfo
  & (
    | TextPart
    | FilePart
    | ContactsPart
    | LocationPart
    | OrderPart
    | InteractivePart
    | ButtonPart
    | MediaPlaceholderPart
    | UnsupportedPart
    | ReferralPart
    | ReactionPart
    | SharePart
    | Parts
  );

export type InternalMessage =
  & {
    version: "1";
    re_message_id?: string; // replied, reacted or forwarded message id
    forwarded?: boolean;
    mentions?: Mention[];
    /**
     * Record-only: this row is never dispatched, to anyone. Declared here so
     * the marker travels with the content instead of living in a column
     * readers must know to consult. Writers set it themselves AND insert the
     * row unarmed (status {}, no pending) — agent-client does both on tool
     * traces and errors; the database reads the marker (dispatch and agent
     * triggers refuse it) but never stamps or strips anything.
     */
    internal?: true;
  }
  & TaskInfo
  & ToolInfo
  & Part;

export type OutgoingMessage =
  & {
    version: "1";
    re_message_id?: string; // replied, reacted or forwarded message id
    forwarded?: boolean;
    mentions?: Mention[];
  }
  & TaskInfo
  & (
    | TextPart
    | FilePart
    | ContactsPart
    | LocationPart
    | TemplatePart
    | ReactionPart
  );

/**
 * A tool trace — a record-only row carrying a tool call/result.
 *
 * Written as a type guard because the content union is only narrowable by a
 * predicate: it includes the open `Json` shape, so `"tool" in content`
 * proves nothing to the compiler.
 */
export function isToolTrace<T extends { content: unknown }>(
  message: T,
): message is T & { content: InternalMessage & Required<ToolInfo> } {
  const content = message.content as InternalMessage | null | undefined;

  return Boolean(content?.tool);
}

/**
 * Any record-only row — tool traces, agent errors, internal notes.
 * `content.internal` is the one marker; a tool trace carries it too, because
 * its writer declares it.
 */
export function isInternal(message: { content: unknown }): boolean {
  const content = message.content as InternalMessage | null | undefined;

  return Boolean(content?.internal);
}
