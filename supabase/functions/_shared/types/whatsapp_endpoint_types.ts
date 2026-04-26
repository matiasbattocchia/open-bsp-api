import type {
  ContactsMessage,
  LocationMessage,
} from "./whatsapp_incoming_message_types.ts";
import type { TemplateMessage } from "./whatsapp_template_types.ts";
import type {
  OutgoingAudio,
  OutgoingContextInfo,
  OutgoingDocument,
  OutgoingImage,
  OutgoingReaction,
  OutgoingSticker,
  OutgoingText,
  OutgoingVideo,
} from "./whatsapp_cloud_outgoing_types.ts";

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
