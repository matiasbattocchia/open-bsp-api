//===================================
// Instagram Send API Types
// (Instagram API with Instagram Login)
// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
//
// Outgoing payloads POSTed to
//   https://graph.instagram.com/<VERSION>/<IG_USER_ID>/messages
//
// Unlike WhatsApp, Instagram has no media upload step for messaging: media is
// referenced by a public `url` (or a previously uploaded `attachment_id`).
// There is also no caption field on attachments — a caption must be sent as a
// separate text message.
//===================================

export type IgRecipient = { id: string };

// Media is referenced either by a public URL or by an attachment_id obtained
// from the Attachment Upload API (we only use `url`).
export type IgMediaPayload = { url: string } | { attachment_id: string };

// Attachment types accepted by the Send API. WhatsApp's "document" maps to "file".
export type IgAttachmentType = "image" | "audio" | "video" | "file";

export type IgOutgoingText = {
  text: string; // UTF-8, up to 1000 bytes
};

export type IgOutgoingAttachment = {
  attachment: {
    type: IgAttachmentType;
    payload: IgMediaPayload;
  };
};

// Heart sticker — the only sticker the Send API supports.
export type IgOutgoingLikeHeart = {
  attachment: {
    type: "like_heart";
  };
};

export type IgEndpointMessage = {
  recipient: IgRecipient;
  message: IgOutgoingText | IgOutgoingAttachment | IgOutgoingLikeHeart;
};

// Reactions are delivered as sender actions carrying a payload.
export type IgReactionAction =
  | {
    recipient: IgRecipient;
    sender_action: "react";
    payload: { message_id: string; reaction: string };
  }
  | {
    recipient: IgRecipient;
    sender_action: "unreact";
    payload: { message_id: string };
  };

// Typing indicators and read receipts. These requests must include only the
// `recipient` object and the `sender_action` — no message payload.
export type IgSenderAction = {
  recipient: IgRecipient;
  sender_action: "mark_seen" | "typing_on" | "typing_off";
};

export type IgEndpointPayload =
  | IgEndpointMessage
  | IgReactionAction
  | IgSenderAction;

// Response for a message send. Sender-action / reaction responses omit
// `message_id`, so consumers only read it for message sends.
export type IgEndpointMessageResponse = {
  recipient_id: string;
  message_id: string;
};

// Graph API error envelope. Instagram messaging surfaces the same shape as
// WhatsApp, additionally carrying `is_transient` to flag retryable failures.
export type IgErrorResponse = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    is_transient?: boolean;
  };
};
