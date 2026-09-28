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

export type OutgoingFlow = {
  type: "interactive";
  interactive: {
    type: "flow";
    header?: { type: "text"; text: string };
    body: { text: string };
    footer?: { text: string };
    action: {
      name: "flow";
      parameters: {
        flow_message_version: "3";
        flow_cta: string;
        flow_id?: string;
        flow_name?: string;
        flow_token: string;
        flow_action?: "navigate" | "data_exchange";
        flow_action_payload?: {
          screen?: string;
          data?: Record<string, unknown>;
        };
        mode?: "draft" | "published";
      };
    };
  };
};

export type OutgoingReplyButtons = {
  type: "interactive";
  interactive: {
    type: "button";
    header?: { type: "text"; text: string };
    body: { text: string };
    footer?: { text: string };
    action: {
      buttons: {
        type: "reply";
        reply: { id: string; title: string };
      }[];
    };
  };
};

export type OutgoingCtaUrl = {
  type: "interactive";
  interactive: {
    type: "cta_url";
    header?: { type: "text"; text: string };
    body: { text: string };
    footer?: { text: string };
    action: {
      name: "cta_url";
      parameters: {
        display_text: string;
        url: string;
      };
    };
  };
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
    to?: string; // phone number; omitted when messaging a BSUID only
    recipient?: string; // BSUID (or parent BSUID); takes a back seat to `to`
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
    | OutgoingFlow
    | OutgoingReplyButtons
    | OutgoingCtaUrl
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
