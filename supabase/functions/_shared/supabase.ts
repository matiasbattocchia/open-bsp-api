import { createClient as createClientBase } from "@supabase/supabase-js";
import {
  Database as DatabaseGenerated,
  Json,
  Tables,
} from "../_shared/db_types.ts";
import { MergeDeep } from "https://esm.sh/type-fest@^4.11.1";
import type { TaskState } from "./a2a_types.ts";
import type { SQLToolConfig } from "../agent-client/tools/sql.ts";
export type { Tables };

// This is what Supabase webhooks send to functions
export type WebhookPayload<Record> = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record | null;
  old_record: Record | null;
};

//===================================
// Webhook Message, as received from WhatsApp
//===================================

export type SystemMessage = {
  type: "system";
  system: {
    body: string; // Describes the change to the customer's identity or phone number.
    customer: string; // The WhatsApp ID for the customer prior to the update.
    identity: string; // Hash for the identity fetched from server.
    type: "customer_changed_number" | "customer_identity_changed";
    wa_id: string; // New WhatsApp ID for the customer when their phone number is updated. Available on webhook versions v12.0 and later.
  };
  identity?: {
    acknowledged: boolean; // State of acknowledgment for the messages system customer_identity_changed.
    created_timestamp: string; // The time when the WhatsApp Business Management API detected the customer may have changed their profile information.
    hash: string; // The ID for the messages system customer_identity_changed
  };
};

export type UnsupportedMessage = {
  type: "unsupported" | "unknown";
  errors: {
    code: number;
    error_data: { details: string };
    message: string;
    title: string;
  }[];
};

// Shared types

// Only included when a user replies or interacts with one of your messages.
export type IncomingContextInfo = {
  context?: {
    forwarded?: boolean;
    frequently_forwarded?: boolean;
    from?: string; // The WhatsApp ID for the customer who replied to an inbound message.
    id?: string; //  The message ID for the sent message for an inbound reply.
    referred_product?: {
      catalog_id: string;
      product_retailer_id: string;
    };
  };
};

/** Present in types:
 * - text
 * - location
 * - contact
 * - image
 * - video
 * - document
 * - audio
 * - sticker
 */
export type ReferralInfo = {
  referral?: {
    source_url: string;
    source_type: "ad" | "post";
    source_id: string;
    headline: string;
    body: string;
    ctwa_clid: string;
  } & (
    | {
        media_type: "image";
        image_url: string;
      }
    | {
        media_type: "video";
        video_url: string;
        thumbnail_url?: string;
      }
  );
};

// Text based

export type TextMessage = {
  type: "text";
  text: {
    body: string;
  };
} & ReferralInfo;

export type ReactionMessage = {
  type: "reaction";
  reaction: {
    message_id: string;
    emoji?: string;
  };
};

// File based

export type AudioMessage = {
  type: "audio";
  audio: {
    id: string;
    mime_type:
      | "audio/aac"
      | "audio/amr"
      | "audio/mpeg"
      | "audio/mp4"
      | "audio/ogg; codecs=opus";
    voice: boolean;
  };
} & ReferralInfo;

export type ImageMessage = {
  type: "image";
  image: {
    id: string;
    mime_type: "image/jpeg" | "image/png" | "image/webp";
    sha256: string;
    caption?: string;
  };
} & ReferralInfo;

export type VideoMessage = {
  type: "video";
  video: {
    id: string;
    mime_type: "video/3gp" | "video/mp4";
    sha256: string;
    caption?: string;
    filename: string;
  };
} & ReferralInfo;

export type DocumentMessage = {
  type: "document";
  document: {
    caption?: string;
    filename: string;
    id: string;
    sha256: string;
    mime_type:
      | "text/plain"
      | "application/vnd.ms-excel"
      | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      | "application/msword"
      | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      | "application/vnd.ms-powerpoint"
      | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      | "application/pdf";
  };
} & ReferralInfo;

export type StickerMessage = {
  type: "sticker";
  sticker: {
    id: string;
    mime_type: "image/webp";
    sha256: string;
    animated: boolean;
  };
} & ReferralInfo;

// Data based

// This message type is produced when the user interacts with a template message button.
export type ButtonMessage = {
  type: "button";
  button: {
    text: string;
    payload: string;
  };
};

// This message type is produced when the user interacts with an interactive message button or list option.
export type InteractiveMessage = {
  type: "interactive";
  interactive:
    | { type: "button_reply"; button_reply: { id: string; title: string } }
    | {
        type: "list_reply";
        list_reply: { id: string; title: string; description?: string };
      };
};

// ORDER

export type Order = {
  catalog_id: string;
  product_items: {
    product_retailer_id: string;
    quantity: string;
    item_price: string;
    currency: string;
  }[];
  text: string;
};

export type OrderMessage = {
  type: "order";
  order: Order;
};

// CONTACTS

export type Contact = {
  name: {
    first_name?: string;
    formatted_name: string;
    last_name?: string;
    middle_name?: string;
    suffix?: string;
    prefix?: string;
  };
  phones?: {
    phone: string;
    type: string;
    wa_id?: string;
  }[];
};

export type ContactsMessage = {
  type: "contacts";
  contacts: Contact[];
} & ReferralInfo;

// LOCATION

export type Location = {
  address: string;
  latitude: number;
  longitude: number;
  name: string;
  url?: string;
};

export type LocationMessage = {
  type: "location";
  location: Location;
} & ReferralInfo;

// Message format received from the WhatsApp webhook
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
export type WebhookMessage = {
  from: string;
  to: string;
  id: string;
  timestamp: number;
} & IncomingContextInfo &
  (
    | AudioMessage
    | ButtonMessage
    | ContactsMessage
    | DocumentMessage
    | ImageMessage
    | InteractiveMessage
    | LocationMessage
    | OrderMessage
    | ReactionMessage
    | StickerMessage
    | SystemMessage
    | TextMessage
    | UnsupportedMessage
    | VideoMessage
  );

//===================================
// Incoming Message v0, as stored in the database
//===================================

export type BaseMessage = {
  content?: string;
  re_message_id?: string; // replied, reacted or forwarded message id
  forwarded?: boolean;
  // TODO: draft?: { approved_by_agent_id: string };
  media?: {
    id: string;
    mime_type: string;
    file_size?: number;
    filename?: string;
    voice?: boolean; // used to distinguish voice messages from other audios
    animated?: boolean; // used to distinguish animated stickers from static stickers
    annotation?: string; // image and video transcription
    description?: string; // image and video description
    url?: string; // WhatsApp can attach media from a URL
  };
  artifacts?: Part[];
};

export type IncomingMessage = { version?: "0" } & BaseMessage &
  IncomingContextInfo &
  TaskInfo &
  (
    | Omit<AudioMessage, "audio">
    | ButtonMessage
    | ContactsMessage
    | Omit<DocumentMessage, "document">
    | Omit<ImageMessage, "image">
    | InteractiveMessage
    | LocationMessage
    | OrderMessage
    | Omit<ReactionMessage, "reaction">
    | Omit<StickerMessage, "sticker">
    | Omit<TextMessage, "text">
    | Omit<VideoMessage, "video">
  );

//===================================
// Function Messages v0
//===================================

export type FunctionCallMessage = {
  type: "function";
  v1_type: "text" | "data"; // hack for v0 to v1 compatibility
  id: string;
  function: {
    arguments: string;
    name: string;
  };
  artifacts?: Part[];
} & TaskInfo &
  ToolInfo;

export type FunctionResponseMessage = {
  type: "text";
  v1_type: "text" | "data"; // hack for v0 to v1 compatibility
  content: string;
  tool_call_id: string;
  tool_name?: string;
  artifacts?: Part[];
} & TaskInfo &
  ToolInfo;

//===================================
// Outgoing Message v0, as stored in the database
//===================================

export type OutgoingContextInfo = {
  context?: { message_id: string };
};

// TEMPLATE

// Template data, used to create or update a template message

export type TemplateData = {
  id: string;
  name: string;
  status:
    | "APPROVED"
    | "IN_APPEAL"
    | "PENDING"
    | "REJECTED"
    | "PENDING_DELETION"
    | "DELETED"
    | "DISABLED"
    | "PAUSED"
    | "LIMIT_EXCEEDED";
  category: "MARKETING"; // TODO: service and auth categories - cabra 2024/09/12
  language: string;
  components: (
    | BodyComponent
    | HeaderComponent
    | FooterComponent
    | ButtonsComponent
  )[];
  sub_category: "CUSTOM";
};

type HeaderComponent = {
  type: "HEADER";
  text: string;
  format: "TEXT"; // TODO: other formats such as image - cabra 2024/09/12
  example?: {
    header_text: [string];
  };
};

type BodyComponent = {
  type: "BODY";
  text: string;
  example?: {
    body_text: [string[]];
  };
};

type FooterComponent = {
  type: "FOOTER";
  text: string;
};

type ButtonsComponent = {
  type: "BUTTONS";
  buttons: QuickReply[]; // TODO: call to action buttons - cabra 2024/09/12
};

type QuickReply = {
  type: "QUICK_REPLY";
  text: string;
};

// Template message, used to send a template message

type CurrencyParameter = {
  type: "currency";
  currency: {
    fallback_value: string;
    code: string; // ISO 4217
    amount_1000: number;
  };
};

type DateTimeParameter = {
  type: "date_time";
  date_time: {
    fallback_value: string;
    // localization is not attempted by Cloud API, fallback_value is always used
  };
};

type TextParameter = {
  type: "text";
  text: string;
};

type TemplateParameter =
  | CurrencyParameter
  | DateTimeParameter
  | TextParameter
  | OutgoingImage
  | OutgoingVideo
  | OutgoingDocument;

type TemplateHeader = {
  type: "header";
  parameters?: TemplateParameter[];
};

type TemplateBody = {
  type: "body";
  parameters?: TemplateParameter[];
};

type TemplateButton = {
  type: "button";
  index: string; // 0-9
} & (
  | {
      sub_type: "quick_reply";
      parameters: {
        type: "payload";
        payload: string;
      }[];
    }
  | {
      sub_type: "url";
      parameters: {
        type: "url";
        text: string;
      }[];
    }
);

export type Template = {
  components?: (TemplateHeader | TemplateBody | TemplateButton)[];
  language: {
    code: string; // es, es_AR, etc
    policy: "deterministic";
  };
  name: string;
};

export type TemplateMessage = {
  type: "template";
  template: Template;
};

// TODO: InteractiveMessage

export type OutgoingMessage = { version?: "0" } & BaseMessage &
  OutgoingContextInfo &
  TaskInfo &
  (
    | Omit<AudioMessage, "audio">
    | ContactsMessage
    | Omit<DocumentMessage, "document">
    | Omit<ImageMessage, "image">
    | LocationMessage
    | Omit<ReactionMessage, "reaction">
    | Omit<StickerMessage, "sticker">
    | TemplateMessage
    | Omit<TextMessage, "text">
    | Omit<VideoMessage, "video">
  );

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
  tool?: ToolEventInfo &
    (LocalToolInfo | GoogleToolInfo | OpenAIToolInfo | AnthropicToolInfo);
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

// Multi-part messages

export type Part = TextPart | DataPart | FilePart;

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

type IncomingMessageV1 = {
  version: "1";
  re_message_id?: string; // replied, reacted or forwarded message id
  forwarded?: boolean;
} & TaskInfo &
  (
    | TextPart
    | FilePart
    | ContactsPart
    | LocationPart
    | OrderPart
    | InteractivePart
    | ButtonPart
  );

export type InternalMessageV1 = {
  version: "1";
  re_message_id?: string; // replied, reacted or forwarded message id
  forwarded?: boolean;
} & TaskInfo &
  ToolInfo &
  Part;

type OutgoingMessageV1 = {
  version: "1";
  re_message_id?: string; // replied, reacted or forwarded message id
  forwarded?: boolean;
} & TaskInfo &
  (TextPart | FilePart | ContactsPart | LocationPart | TemplatePart);

//===================================
// Endpoint Message v0, as sent to the WhatsApp endpoint
//===================================

// Text based

export type OutgoingText = {
  type: "text";
  text: {
    body: string;
    preview_url?: boolean;
  };
};

export type OutgoingReaction = {
  type: "reaction";
  reaction: {
    emoji: string;
    message_id: string;
  };
};

// File based

export type OutgoingAudio = {
  type: "audio";
  audio: { id: string } | { link: string };
};

export type OutgoingImage = {
  type: "image";
  image: ({ id: string } | { link: string }) & { caption?: string };
};

export type OutgoingVideo = {
  type: "video";
  video: ({ id: string } | { link: string }) & { caption?: string };
};

export type OutgoingDocument = {
  type: "document";
  document: ({ id: string } | { link: string }) & {
    caption?: string;
    filename?: string;
  };
};

export type OutgoingSticker = {
  type: "sticker";
  sticker: { id: string } | { link: string };
};

// Message format sent to the WhatsApp endpoint
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
export type EndpointMessage = {
  biz_opaque_callback_data?: string;
  messaging_product: "whatsapp";
  recipient_type?: "individual";
  to: string;
} & OutgoingContextInfo &
  (
    | OutgoingAudio
    | ContactsMessage
    | OutgoingDocument
    | OutgoingImage
    | LocationMessage
    | OutgoingReaction
    | OutgoingSticker
    | TemplateMessage
    | OutgoingText
    | OutgoingVideo
  );

//===================================
// Statuses
//===================================

type ConversationType =
  | "authentication"
  | "marketing"
  | "utility"
  | "service"
  | "referral_conversion";

/** STATUS
 *
 * 1. Sent messages
 *    WebhookStatus -> OutgoingStatus
 *
 * 2. Received messages
 *    IncomingStatus -> EndpointStatus
 */

export type WebhookStatus = {
  biz_opaque_callback_data?: string;
  id: string;
  recipient_id: string;
  timestamp: string;
} & (
  | {
      status: "sent";
      conversation: {
        id: string;
        origin: {
          type: ConversationType;
        };
        expiration_timestamp: string;
      };
      pricing: {
        billable: boolean;
        category: ConversationType;
        pricing_model: "CBP";
      };
    }
  | {
      status: "delivered";
      conversation: {
        id: string;
        origin: {
          type: ConversationType;
        };
      };
      pricing: {
        billable: boolean;
        category: ConversationType;
        pricing_model: "CBP";
      };
    }
  | {
      status: "read";
    }
  | {
      status: "failed";
      errors: {
        code: number;
        error_data: { details: string };
        message: string;
        title: string;
      }[];
    }
);

export type IncomingStatus = {
  pending?: string; // new Date().toISOString()
  read?: string;
  typing?: string;
  annotating?: string;
  annotated?: string;
};

export type OutgoingStatus = {
  pending?: string; // new Date().toISOString()
  held_for_quality_assessment?: string;
  accepted?: string;
  sent?: string;
  delivered?: string;
  read?: string;
  failed?: string;
  annotating?: string;
  annotated?: string;
  conversation?: {
    id: string;
    type: ConversationType;
    expiration_timestamp: string;
  };
  errors?: string[];
};

export type EndpointStatus = {
  messaging_product: "whatsapp";
  status: "read";
  message_id: string;
  typing_indicator?: {
    type: "text";
  };
};

//===================================
// Extra
//===================================

export type Memory = {
  [key: string]: string | undefined | Memory;
};

export type AnnotationConfig = {
  mode?: "active" | "inactive";
  model?: "gemini-2.5-pro" | "gemini-2.5-flash";
  api_key?: string;
  language?: string;
  extra_prompt?: string;
};

export type OrganizationExtra = {
  response_delay_seconds?: number;
  welcome_message?: string;
  authorized_contacts_only?: boolean;
  default_agent_id?: string;
  annotations?: AnnotationConfig;
  error_messages_direction?: "internal" | "outgoing";
};

export type ConversationExtra = {
  type?: "personal" | "group" | "test" | "test_run";
  memory?: Memory;
  paused?: string;
  archived?: string;
  pinned?: string;
  notifications?: "off" | "muted" | "on";
  test_run?: {
    reference_conversation: {
      organization_address: string;
      contact_address: string;
    };
    status?: "fail" | "success";
    reference_message_id?: string;
  };
};

export type ContactExtra = {
  allowed?: boolean;
  group?: string;
};

// Function tools have a JSON input (data part).
export type LocalFunctionToolConfig = {
  provider: "local";
  type: "function";
  name: string;
};

// Custom tools have a free-grammar input (text part).
export type LocalCustomToolConfig = {
  provider: "local";
  type: "custom";
  name: string;
};

export type LocalSimpleToolConfig =
  | LocalFunctionToolConfig
  | LocalCustomToolConfig;

export type LocalMCPToolConfig = {
  provider: "local";
  type: "mcp";
  label: string; // server label
  config: {
    url: string;
    headers?: Record<string, string>;
    allowed_tools?: string[];
  };
};

export type LocalSQLToolConfig = {
  provider: "local";
  type: "sql";
  label: string; // database label
  config: SQLToolConfig;
};

export type LocalHTTPToolConfig = {
  provider: "local";
  type: "http";
  label: string; // client label
  config: {
    headers?: Record<string, string>;
  };
};

export type LocalSpecialToolConfig = LocalSQLToolConfig | LocalHTTPToolConfig;

export type ToolConfig =
  | LocalSimpleToolConfig
  | LocalSpecialToolConfig
  | LocalMCPToolConfig;

export type AgentExtra = {
  mode?: "active" | "draft" | "inactive";
  description?: string;
  api_url?: string;
  api_key?: string;
  model?: string;
  // TODO: Deprecate assistants. Add responses (openai), messages (anthropic), generate-content (google).
  protocol?: "a2a" | "chat_completions" | "assistants";
  assistant_id?: string;
  max_messages?: number;
  temperature?: number;
  max_tokens?: number;
  thinking?: "minimal" | "low" | "medium" | "high";
  instructions?: string;
  send_inline_files_up_to_size_mb?: number;
  tools?: ToolConfig[];
  toolkits?: {
    name: string;
    tools: {
      name: string;
      [key: string]: any;
    }[];
  }[]; // TODO: Deprecate in favour of tools
  role?: string; // TODO: Deprecate in favour of description
  prompt?: string; // TODO: Deprecate in favour of instructions
  provider?: string; // TODO: Deprecate in favour of api_url
};

export type Database = MergeDeep<
  DatabaseGenerated,
  {
    public: {
      Tables: {
        organizations: {
          Row: {
            extra: OrganizationExtra | null;
          };
        };
        conversations: {
          Row: {
            extra: ConversationExtra | null;
          };
        };
        messages: {
          Row:
            | {
                direction: "incoming" | "internal";
                type: "incoming" | "internal";
                message: IncomingMessage; // TODO: | IncomingMessageV1;
                status: IncomingStatus;
              }
            | {
                direction: "outgoing" | "internal";
                type: "outgoing" | "draft";
                message: OutgoingMessage; // TODO: | OutgoingMessageV1;
                status: OutgoingStatus;
              }
            | {
                direction: "internal";
                type: "function_call"; // TODO: deprecate
                message: FunctionCallMessage;
                status: IncomingStatus;
              }
            | {
                direction: "internal";
                type: "function_response"; // TODO: deprecate
                message: FunctionResponseMessage;
                status: IncomingStatus;
              };
          Insert:
            | {
                type: "incoming" | "internal";
                message: IncomingMessage;
                status?: IncomingStatus;
              }
            | {
                type: "outgoing" | "draft";
                message: OutgoingMessage | IncomingMessage;
                status?: OutgoingStatus;
              }
            | {
                type: "function_call"; // TODO: deprecate
                message: FunctionCallMessage;
                status?: IncomingStatus;
              }
            | {
                type: "function_response"; // TODO: deprecate
                message: FunctionResponseMessage;
                status?: IncomingStatus;
              };
          Update:
            | {
                type?: "incoming" | "internal";
                message?: IncomingMessage;
                status?: IncomingStatus;
              }
            | {
                type?: "outgoing" | "draft";
                message?: OutgoingMessage;
                status?: OutgoingStatus;
              }
            | {
                type?: "function_call"; // TODO: deprecate
                message?: FunctionCallMessage;
                status?: IncomingStatus;
              }
            | {
                type?: "function_response"; // TODO: deprecate
                message?: FunctionResponseMessage;
                status?: IncomingStatus;
              };
        };
        contacts: {
          Row: {
            extra: ContactExtra | null;
          };
        };
        agents: {
          Row: {
            extra: AgentExtra | null;
          };
        };
      };
    };
  }
>;

export type DatabaseV1 = MergeDeep<
  DatabaseGenerated,
  {
    public: {
      Tables: {
        messages: {
          Row:
            | {
                direction: "incoming";
                type: "incoming";
                message: IncomingMessageV1;
                status: IncomingStatus;
              }
            | {
                direction: "internal";
                type:
                  | "internal"
                  | "draft"
                  | "function_response"
                  | "function_call";
                message: InternalMessageV1;
                status: IncomingStatus;
              }
            | {
                direction: "outgoing";
                type: "outgoing";
                message: OutgoingMessageV1;
                status: OutgoingStatus;
              };
          Insert:
            | {
                direction: "incoming";
                type: "incoming";
                message: IncomingMessageV1;
                status?: IncomingStatus;
              }
            | {
                direction: "internal";
                type:
                  | "internal"
                  | "draft"
                  | "function_response"
                  | "function_call";
                message: InternalMessageV1;
                status?: IncomingStatus;
              }
            | {
                direction: "outgoing";
                type: "outgoing";
                message: OutgoingMessageV1;
                status?: OutgoingStatus;
              };
        };
      };
    };
  }
>;

export type MessageRowV1 = DatabaseV1["public"]["Tables"]["messages"]["Row"];
export type MessageInsertV1 =
  DatabaseV1["public"]["Tables"]["messages"]["Insert"];
export type MessageUpdateV1 =
  DatabaseV1["public"]["Tables"]["messages"]["Update"];

export type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
export type MessageInsert = Database["public"]["Tables"]["messages"]["Insert"];
export type MessageUpdate = Database["public"]["Tables"]["messages"]["Update"];

export type ConversationInsert =
  Database["public"]["Tables"]["conversations"]["Insert"];
export type ConversationRow =
  Database["public"]["Tables"]["conversations"]["Row"];

export type OrganizationRow =
  Database["public"]["Tables"]["organizations"]["Row"];

export type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];

export type AgentRow = Database["public"]["Tables"]["agents"]["Row"];

export function createClient(req: Request) {
  if (!Deno.env.get("SUPABASE_URL")) {
    throw new Error("Undefined SUPABASE_URL env var.");
  }

  if (!Deno.env.get("SUPABASE_ANON_KEY")) {
    throw new Error("Undefined SUPABASE_ANON_KEY env var.");
  }

  return createClientBase<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      auth: { persistSession: false },
      global: {
        headers: {
          Authorization: req.headers.get("Authorization") || "",
        },
      },
    },
  );
}

export function createApiClient(token?: string) {
  if (!Deno.env.get("SUPABASE_URL")) {
    throw new Error("Undefined SUPABASE_URL env var.");
  }

  if (!Deno.env.get("SUPABASE_ANON_KEY")) {
    throw new Error("Undefined SUPABASE_ANON_KEY env var.");
  }

  return createClientBase<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      auth: { persistSession: false },
      global: {
        headers: {
          "x-app-api-key": token || "",
        },
      },
    },
  );
}

export function createUnsecureClient() {
  if (!Deno.env.get("SUPABASE_URL")) {
    throw new Error("Undefined SUPABASE_URL env var.");
  }

  if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    throw new Error("Undefined SUPABASE_SERVICE_ROLE_KEY env var.");
  }

  return createClientBase<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {
      auth: { persistSession: false },
    },
  );
}
