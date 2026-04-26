import type { WebhookError } from "./webhook_error.ts";
import type { WebhookStatus } from "./status_types.ts";

//===================================
// Webhook Message, as received from WhatsApp
//===================================

export type SystemMessage = {
  type: "system";
  system: {
    body: string; // Describes the change to the user's phone number.
    type: "user_changed_number";
    wa_id: string; // New WhatsApp ID for the user when their phone number is updated.
  };
};

export type UnsupportedMessage = {
  type: "unsupported";
  errors: Omit<WebhookError, "href">[];
  unsupported: {
    type: "edit" | "poll" | "button";
  };
};

export type ErrorsMessage = {
  errors: Omit<WebhookError, "href">[];
  type: "errors";
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
    ctwa_clid?: string; // The ctwa_clid property is omitted entirely for messages originating from an ad in WhatsApp Status
    welcome_message: {
      text: string;
    };
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

export type MediaPlaceholder = { type: "media_placeholder" };

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
export type HistoryContext = {
  status: WebhookStatus["status"];
};

export type WebhookMessageBase =
  & {
    from: string;
    group_id?: string;
    id: string;
    timestamp: number;
  }
  & (
    | AudioMessage
    | ButtonMessage
    | ContactsMessage
    | DocumentMessage
    | ErrorsMessage
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
    | MediaPlaceholder
  );
