import type {
  ContactsMessage,
  LocationMessage,
} from "./whatsapp_webhook_message_types.ts";
import type { TemplateMessage } from "./whatsapp_template_types.ts";

//===================================
// Outgoing message components, as sent to the WhatsApp Cloud API
//===================================

export type OutgoingContextInfo = {
  context?: { message_id: string };
};

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
  audio: ({ id: string } | { link: string }) & { voice?: boolean };
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

//===================================
// Endpoint message, as sent to the WhatsApp endpoint
//===================================

// Message format sent to the WhatsApp endpoint
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
export type EndpointMessage =
  & {
    biz_opaque_callback_data?: string;
    messaging_product: "whatsapp";
    recipient_type?: "individual";
    to: string;
  }
  & OutgoingContextInfo
  & (
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

export type EndpointMessageResponse = {
  messaging_product: "whatsapp";
  contacts: [
    {
      input: string;
      wa_id: string;
    },
  ];
  messages: [
    {
      id: string;
      group_id?: string;
      message_status?: "accepted" | "held_for_quality_assessment";
    },
  ];
};
