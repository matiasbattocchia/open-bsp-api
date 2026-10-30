// TikTok API for Business webhooks (DIRECT_MESSAGE subscription), the subset
// we read. Field names follow TikTok's; `content` arrives as serialized JSON.

/** The envelope every webhook POST carries. */
export type TikTokWebhookPayload = {
  client_key?: string;
  event?: string;
  create_time?: number; // seconds
  /** The business account the event is for: its open_id. */
  user_openid?: string;
  content?: string | Record<string, unknown>;
};

export type TikTokWebhookParticipant = {
  id?: string;
  role?: "business_account" | "personal_account";
};

export type TikTokWebhookReaction = {
  operation?: "ADD" | "REMOVE";
  type?: "EMOJI" | "AI_EMOJI";
  emoji?: string;
  ai_emoji_url?: string;
  unique_identifier?: string;
  timestamp?: number; // milliseconds
  original_msg_id?: string;
};

export type TikTokWebhookTemplate = {
  type?: "QA_BUTTON_CARD" | "QA_LINK_CARD";
  title?: string;
  buttons?: { type?: string; title?: string; id?: string }[];
};

/** The `content` of im_receive_msg and im_send_msg. */
export type TikTokDirectMessage = {
  /** Username of the sender. */
  from?: string;
  /** Username of the recipient. */
  to?: string;
  unique_identifier?: string;
  from_user?: TikTokWebhookParticipant;
  to_user?: TikTokWebhookParticipant;
  conversation_id?: string;
  message_id?: string;
  timestamp?: number; // milliseconds
  type?: string;
  text?: { body?: string };
  image?: { media_id?: string };
  video?: { media_id?: string };
  sticker?: { url?: string };
  emoji?: { url?: string };
  share_post?: { video_id?: string; embed_url?: string };
  reaction?: TikTokWebhookReaction[];
  template?: TikTokWebhookTemplate;
  referenced_message_info?: { referenced_message_id?: string };
  /** Present when the text is a click on a Q&A card's button. */
  reply_source_payload?: {
    reply_source_msg_id?: string;
    reply_source_unique_id?: string;
  };
  auto_message_type?: string;
  is_follower?: boolean;
  message_tag?: { source?: "APP" | "WEB" | "API" | "OTHERS" | string };
};
