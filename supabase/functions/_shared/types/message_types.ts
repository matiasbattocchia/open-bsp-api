import type { TaskState } from "../a2a_types.ts";
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
import type {
  InstagramAttachmentPayload,
  InstagramReferral,
} from "./instagram_webhook_payload_types.ts";

//===================================
// Agent Protocol Types
//===================================

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
    uri: string; // --> internal://media/organizations/${organization_id}/attachments/${file_hash}
    name?: string;
    size: number;
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

type MediaPlaceholderPart = DataPart<
  "media_placeholder",
  Record<PropertyKey, never>
>;

type UnsupportedPart = DataPart<
  "unsupported",
  UnsupportedMessage["unsupported"]
>;

// Instagram-native data parts. Kind = native IG attachment type; data carries the raw
// attachment payload so business logic can resolve it later (e.g. fetching post media).
type IgPostPart = DataPart<"ig_post", InstagramAttachmentPayload>;
type StoryMentionPart = DataPart<"story_mention", InstagramAttachmentPayload>;
type IgReelPart = DataPart<"ig_reel", InstagramAttachmentPayload>;
type ReelPart = DataPart<"reel", InstagramAttachmentPayload>;
type StoryPart = DataPart<"story", InstagramAttachmentPayload>;
type IgStoryPart = DataPart<"ig_story", InstagramAttachmentPayload>;
// Synthetic content for messaging_referral events (no message attached).
type ReferralPart = DataPart<"referral", InstagramReferral>;

// Multi-part messages

export type Part =
  | TextPart
  | DataPart
  | FilePart
  // Instagram-native data parts can appear inside a Parts bundle (e.g. when an
  // event delivers multiple attachments alongside text).
  | IgPostPart
  | StoryMentionPart
  | IgReelPart
  | ReelPart
  | StoryPart
  | IgStoryPart;

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
    re_story?: { url: string; id: string }; // Instagram story reply (no mid)
    forwarded?: boolean;
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
    | IgPostPart
    | StoryMentionPart
    | IgReelPart
    | ReelPart
    | StoryPart
    | IgStoryPart
    | ReferralPart
    | Parts
  );

export type InternalMessage =
  & {
    version: "1";
    re_message_id?: string; // replied, reacted or forwarded message id
    forwarded?: boolean;
  }
  & TaskInfo
  & ToolInfo
  & Part;

export type OutgoingMessage =
  & {
    version: "1";
    re_message_id?: string; // replied, reacted or forwarded message id
    forwarded?: boolean;
  }
  & TaskInfo
  & (TextPart | FilePart | ContactsPart | LocationPart | TemplatePart);
