import { type MessageRow } from "./supabase.ts";
import { Database as DatabaseGenerated, Json } from "../_shared/db_types.ts";

// MINIMAL VERSION of supabase.ts for MessageRowV0

type TaskInfo = {
  task?: {
    id: string;
    status?: unknown; // TaskState not imported
    session_id?: string;
  };
};

type ToolEventInfo =
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

type LocalToolInfo = LocalSimpleToolInfo | LocalSpecialToolInfo;

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

type ToolInfo = {
  tool?: ToolEventInfo &
    (LocalToolInfo | GoogleToolInfo | OpenAIToolInfo | AnthropicToolInfo);
};

type TextPart = {
  type: "text";
  kind: "text" | "reaction" | "caption" | "transcription" | "description";
  text: string;
  artifacts?: Part[];
};

const MediaTypes = ["audio", "image", "video", "document", "sticker"] as const;

type FilePart = {
  type: "file";
  kind: (typeof MediaTypes)[number];
  file: {
    mime_type: string;
    uri: string;
    name?: string;
    size: number;
  };
  text?: string; // caption
  artifacts?: Part[];
};

type DataPart<Kind = "data", T = Json> = {
  type: "data";
  kind: Kind;
  data: T;
  artifacts?: Part[];
};

type Part = TextPart | DataPart | FilePart;

type IncomingContextInfo = {
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

type ReferralInfo = {
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

type TextMessage = {
  type: "text";
  text: {
    body: string;
  };
} & ReferralInfo;

type ReactionMessage = {
  type: "reaction";
  reaction: {
    message_id: string;
    emoji?: string;
  };
};

type AudioMessage = {
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

type ImageMessage = {
  type: "image";
  image: {
    id: string;
    mime_type: "image/jpeg" | "image/png" | "image/webp";
    sha256: string;
    caption?: string;
  };
} & ReferralInfo;

type VideoMessage = {
  type: "video";
  video: {
    id: string;
    mime_type: "video/3gp" | "video/mp4";
    sha256: string;
    caption?: string;
    filename: string;
  };
} & ReferralInfo;

type DocumentMessage = {
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

type StickerMessage = {
  type: "sticker";
  sticker: {
    id: string;
    mime_type: "image/webp";
    sha256: string;
    animated: boolean;
  };
} & ReferralInfo;

type MediaPlaceholder = { type: "media_placeholder" };

type ButtonMessage = {
  type: "button";
  button: {
    text: string;
    payload: string;
  };
};

type InteractiveMessage = {
  type: "interactive";
  interactive:
    | { type: "button_reply"; button_reply: { id: string; title: string } }
    | {
        type: "list_reply";
        list_reply: { id: string; title: string; description?: string };
      };
};

type Order = {
  catalog_id: string;
  product_items: {
    product_retailer_id: string;
    quantity: string;
    item_price: string;
    currency: string;
  }[];
  text: string;
};

type OrderMessage = {
  type: "order";
  order: Order;
};

type Contact = {
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

type ContactsMessage = {
  type: "contacts";
  contacts: Contact[];
} & ReferralInfo;

type Location = {
  address: string;
  latitude: number;
  longitude: number;
  name: string;
  url?: string;
};

type LocationMessage = {
  type: "location";
  location: Location;
} & ReferralInfo;

type BaseMessage = {
  content?: string;
  re_message_id?: string; // replied, reacted or forwarded message id
  forwarded?: boolean;
  media?: {
    id: string;
    mime_type: string;
    file_size?: number;
    filename?: string;
    voice?: boolean;
    animated?: boolean;
    annotation?: string;
    description?: string;
    url?: string;
  };
  artifacts?: Part[];
};

// Function messages (deprecated v0 format, still in DB)
type FunctionCallMessage = {
  version?: "0";
  type: "function";
  v1_type: "text" | "data";
  id: string;
  function: {
    arguments: string;
    name: string;
  };
  artifacts?: Part[];
} & TaskInfo &
  ToolInfo;

type FunctionResponseMessage = {
  version?: "0";
  type: "text";
  v1_type: "text" | "data";
  content: string;
  tool_call_id: string;
  tool_name?: string;
  artifacts?: Part[];
} & TaskInfo &
  ToolInfo;

type IncomingMessageV0 = { version?: "0" } & BaseMessage &
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
    | MediaPlaceholder
  );

type OutgoingContextInfo = {
  context?: { message_id: string };
};

type CurrencyParameter = {
  type: "currency";
  currency: {
    fallback_value: string;
    code: string;
    amount_1000: number;
  };
};

type DateTimeParameter = {
  type: "date_time";
  date_time: {
    fallback_value: string;
  };
};

type TextParameter = {
  type: "text";
  text: string;
};

type OutgoingImage = {
  type: "image";
  image: ({ id: string } | { link: string }) & { caption?: string };
};

type OutgoingVideo = {
  type: "video";
  video: ({ id: string } | { link: string }) & { caption?: string };
};

type OutgoingDocument = {
  type: "document";
  document: ({ id: string } | { link: string }) & {
    caption?: string;
    filename?: string;
  };
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
  index: string;
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

type Template = {
  components?: (TemplateHeader | TemplateBody | TemplateButton)[];
  language: {
    code: string;
    policy: "deterministic";
  };
  name: string;
};

type TemplateMessage = {
  type: "template";
  template: Template;
};

type OutgoingMessageV0 = { version?: "0" } & BaseMessage &
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

type MergeDeep<T, U> = {
  [K in keyof T | keyof U]: K extends keyof U
    ? K extends keyof T
      ? T[K] extends object
        ? U[K] extends object
          ? MergeDeep<T[K], U[K]>
          : U[K]
        : U[K]
      : U[K]
    : K extends keyof T
      ? T[K]
      : never;
};

type Database = MergeDeep<
  DatabaseGenerated,
  {
    public: {
      Tables: {
        messages: {
          Row:
            | {
                direction: "incoming";
                content: IncomingMessageV0;
              }
            | {
                direction: "outgoing";
                content: OutgoingMessageV0;
              }
            | {
                direction: "internal";
                content: FunctionCallMessage | FunctionResponseMessage;
              };
        };
      };
    };
  }
>;

export type MessageRowV0 = Database["public"]["Tables"]["messages"]["Row"];

// end of types section

export function toV1(row: MessageRowV0): MessageRow | undefined {
  // Tool use (function call) - detected by row.content.tool
  if (
    row.direction === "internal" &&
    //row.content.tool?.event === "use" &&
    "function" in row.content
  ) {
    if (row.content.v1_type === "data") {
      return {
        ...row,
        content: {
          version: "1",
          // @ts-expect-error type
          task: row.content.task,
          tool: row.content.tool || {
            use_id: row.content.id,
            provider: "local",
            event: "use",
            type: "function",
            name: row.content.function.name,
          },
          type: "data",
          kind: "data",
          data: JSON.parse(row.content.function.arguments),
          artifacts: row.content.artifacts,
        },
      };
    }

    if (row.content.v1_type === "text") {
      return {
        ...row,
        content: {
          version: "1",
          // @ts-expect-error type
          task: row.content.task,
          tool: row.content.tool || {
            use_id: row.content.id,
            provider: "local",
            event: "use",
            type: "function",
            name: row.content.function.name,
          },
          type: "text",
          kind: "text",
          text: row.content.function.arguments,
          artifacts: row.content.artifacts,
        },
      };
    }
  } // Tool result (function response) - detected by row.content.tool
  else if (
    row.direction === "internal" &&
    "tool" in row.content &&
    row.content.tool?.event === "result" &&
    "tool_call_id" in row.content
  ) {
    if (row.content.v1_type === "data") {
      return {
        ...row,
        content: {
          version: "1",
          // @ts-expect-error type
          task: row.content.task,
          tool: row.content.tool || {
            use_id: row.content.tool_call_id,
            provider: "local",
            event: "result",
            type: "function",
            name: row.content.tool_name!,
          },
          type: "data",
          kind: "data",
          data: JSON.parse(row.content.content),
          artifacts: row.content.artifacts,
        },
      };
    }

    if (row.content.v1_type === "text") {
      return {
        ...row,
        content: {
          version: "1",
          // @ts-expect-error type
          task: row.content.task,
          tool: row.content.tool || {
            use_id: row.content.tool_call_id,
            provider: "local",
            event: "result",
            type: "function",
            name: row.content.tool_name!,
          },
          type: "text",
          kind: "text",
          text: row.content.content,
          artifacts: row.content.artifacts,
        },
      };
    }
  } // Media types
  else if ("media" in row.content && row.content.media) {
    // @ts-expect-error type
    return {
      ...row,
      content: {
        version: "1",
        type: "file",
        kind: row.content.type as
          | "image"
          | "audio"
          | "video"
          | "document"
          | "sticker",
        file: {
          mime_type: row.content.media.mime_type,
          size: row.content.media.file_size || 0,
          name: row.content.media.filename,
          uri: row.content.media.id,
        },
        text: row.content.type === "audio" ? "" : row.content.content,
        artifacts: row.content.artifacts,
      },
    };
  } // Text types
  else if ("content" in row.content && row.content.content) {
    // @ts-expect-error type
    return {
      ...row,
      content: {
        version: "1",
        type: "text",
        kind: row.content.type as "text" | "reaction",
        text: row.content.content,
        artifacts: row.content.artifacts,
      },
    };
  } // Data types
  // @ts-expect-error type
  else if (row.content.type in row.content && row.content[row.content.type]) {
    return {
      ...row,
      content: {
        version: "1",
        type: "data",
        // @ts-expect-error type
        kind: row.content.type,
        // @ts-expect-error type
        data: row.content[row.content.type],
        artifacts: row.content.artifacts,
      },
    };
  }

  console.warn("Could not convert message to v1", row);

  return undefined;
}

export function fromV1(row: MessageRow): MessageRowV0 | undefined {
  if (
    row.direction === "internal" &&
    row.content.tool?.event === "use" &&
    row.content.tool?.provider === "local" &&
    row.content.type !== "file"
  ) {
    if (row.content.type === "data") {
      return {
        ...row,
        content: {
          version: "0",
          task: row.content.task,
          type: "function",
          v1_type: "data",
          id: row.content.tool.use_id,
          function: {
            name: row.content.tool.name,
            arguments: JSON.stringify(row.content.data),
          },
          tool: row.content.tool,
          artifacts: row.content.artifacts,
        },
      };
    }

    if (row.content.type === "text") {
      return {
        ...row,
        content: {
          version: "0",
          task: row.content.task,
          type: "function",
          v1_type: "text",
          id: row.content.tool.use_id,
          function: {
            name: row.content.tool.name,
            arguments: row.content.text,
          },
          tool: row.content.tool,
          artifacts: row.content.artifacts,
        },
      };
    }
  } else if (
    row.direction === "internal" &&
    row.content.tool?.event === "result" &&
    row.content.tool?.provider === "local" &&
    row.content.type !== "file"
  ) {
    if (row.content.type === "data") {
      return {
        ...row,
        content: {
          version: "0",
          task: row.content.task,
          v1_type: "data",
          type: "text",
          tool_call_id: row.content.tool.use_id,
          tool_name: row.content.tool.name,
          content: JSON.stringify(row.content.data),
          tool: row.content.tool,
          artifacts: row.content.artifacts,
        },
      };
    }

    if (row.content.type === "text") {
      return {
        ...row,
        content: {
          version: "0",
          task: row.content.task,
          v1_type: "text",
          type: "text",
          tool_call_id: row.content.tool.use_id,
          tool_name: row.content.tool.name,
          content: row.content.text,
          tool: row.content.tool,
          artifacts: row.content.artifacts,
        },
      };
    }
  } else if (row.content.type === "text") {
    return {
      ...row,
      content: {
        version: "0",
        // @ts-expect-error type
        type: row.content.kind,
        content: row.content.text,
        artifacts: row.content.artifacts,
      },
    };
  } else if (row.content.type === "file") {
    const transcription = (
      row.content.artifacts?.find(
        (a) => a.type === "text" && a.kind === "transcription",
      ) as TextPart
    )?.text;
    const description = (
      row.content.artifacts?.find(
        (a) => a.type === "text" && a.kind === "description",
      ) as TextPart
    )?.text;

    return {
      ...row,
      content: {
        version: "0",
        type: row.content.kind,
        content:
          row.content.kind === "audio" ? transcription : row.content.text,
        media: {
          mime_type: row.content.file.mime_type,
          file_size: row.content.file.size,
          filename: row.content.file.name,
          id: row.content.file.uri,
          description,
          ...(row.content.kind === "audio"
            ? {}
            : { annotation: transcription }),
        },
        artifacts: row.content.artifacts,
      },
    };
  } else if (row.content.type === "data") {
    return {
      ...row,
      content: {
        version: "0",
        // @ts-expect-error type
        type: row.content.kind,
        [row.content.kind]: row.content.data,
        artifacts: row.content.artifacts,
      },
    };
  }

  console.warn("Could not convert message to v0", row);

  return undefined;
}
