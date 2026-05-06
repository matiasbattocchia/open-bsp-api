//===================================
// Instagram Webhook Payload Types
// (Instagram API with Instagram Login)
// https://developers.facebook.com/docs/instagram-platform/webhooks/examples#business-login-for-instagram
//
// Instagram is event-oriented (Messenger-style), not array-oriented like WhatsApp.
// An InstagramEvent is a tagged-union container: it carries sender + recipient +
// timestamp plus zero-or-one of {message, postback, reaction, read, message_edit, referral}.
//===================================

export type InstagramAttachmentType =
  | "audio"
  | "file"
  | "image"
  | "video"
  | "media"
  | "ig_post"
  | "story_mention"
  | "ig_reel"
  | "reel"
  | "story"
  | "ig_story";

export type InstagramAttachmentPayload = {
  url?: string;
  title?: string;
};

export type InstagramAttachment = {
  type: InstagramAttachmentType;
  payload: InstagramAttachmentPayload;
};

export type InstagramQuickReply = {
  payload: string;
};

export type InstagramReplyTo = {
  mid?: string;
  story?: { url: string; id: string };
};

// Covers both shapes:
// - inline message.referral (CTD ad form with ads_context_data)
// - top-level event.referral (messaging_referral, ig.me link clicks)
export type InstagramReferral = {
  ref?: string;
  ad_id?: string;
  source: string; // "ADS" for CTD ads; an ig.me source link for messaging_referral
  type?: "OPEN_THREAD";
  ads_context_data?: {
    ad_title?: string;
    photo_url?: string;
    video_url?: string;
  };
};

export type InstagramMessage = {
  mid: string;
  text?: string;
  attachments?: InstagramAttachment[];
  quick_reply?: InstagramQuickReply;
  reply_to?: InstagramReplyTo;
  referral?: InstagramReferral;
  is_echo?: boolean;
  is_self?: boolean;
  is_deleted?: boolean;
  is_unsupported?: boolean;
};

export type InstagramPostback = {
  mid: string;
  title: string;
  payload: string;
};

export type InstagramReaction = {
  mid: string;
  action: "react" | "unreact";
  reaction?: string;
  emoji?: string;
};

export type InstagramRead = {
  mid: string;
};

export type InstagramMessageEdit = {
  mid: string;
  text: string;
  num_edit: string;
};

export type InstagramEvent = {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: InstagramMessage;
  postback?: InstagramPostback;
  reaction?: InstagramReaction;
  read?: InstagramRead;
  message_edit?: InstagramMessageEdit;
  referral?: InstagramReferral;
};

export type InstagramChange = {
  field:
    | "messages"
    | "messaging_postbacks"
    | "messaging_seen"
    | "message_reactions"
    | "message_edit"
    | "messaging_referral";
  value: InstagramEvent;
};

export type InstagramEntry = {
  id: string; // IGSID of the IG business account receiving the event
  time: number;
  messaging?: InstagramEvent[];
  changes?: InstagramChange[];
};

export type InstagramWebhookPayload = {
  object: "instagram";
  entry: InstagramEntry[];
};
