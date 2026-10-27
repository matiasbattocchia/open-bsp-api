import type { WebhookError } from "./whatsapp_webhook_payload_types.ts";

//===================================
// Statuses
//===================================

type PricingCategory =
  | "authentication"
  | "authentication-international"
  | "marketing"
  | "marketing_lite"
  | "referral_conversion"
  | "service"
  | "utility";

type PricingType = "regular" | "free_customer_service" | "free_entry_point";

/** STATUS
 *
 * 1. Sent messages
 *    WebhookStatus -> OutgoingStatus
 *
 * 2. Received messages
 *    IncomingStatus -> EndpointStatus
 */

export type WebhookStatus = {
  id: string; // WhatsApp message ID
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id?: string; // User phone number or group ID. Can be omitted when
  // sent to a BSUID and the phone number is unavailable (see BSUID migration).
  recipient_user_id?: string; // Recipient BSUID. Always set, except for failed
  // status messages sent to a phone number.
  recipient_parent_user_id?: string; // Recipient parent BSUID; only if parent
  // BSUIDs are enabled.
  recipient_type?: "group"; // Only included if message sent to a group
  recipient_participant_id?: string; // Only included if message sent to a group
  recipient_identity_key_hash?: string; // Only included if identity change check enabled
  biz_opaque_callback_data?: string; // Only included if message sent with biz_opaque_callback_data
  pricing?: {
    // Only included with sent status, and one of either delivered or read status
    pricing_model: "PMP";
    category: PricingCategory;
    type: PricingType;
  };
  errors?: WebhookError[]; // Only included if failure to send or deliver message
};

/**
 * A receipt that may be per reader. Scalar when ONE party owes it — an
 * external direct chat, where "read" is a single fact owed to the peer. A
 * map keyed by the reader when several can read: contact addresses on
 * external group messages (WhatsApp group participants), agent ids in team
 * chat (each member's own read). The keying follows authorship space —
 * `sender_address` keys for contacts, `agent_id` keys for members.
 *
 * The status merge is recursive merge-patch, so concurrent readers
 * accumulate key by key, and a `null` value retracts one. Readers that only
 * care about direct chats can narrow with `typeof value === "string"`.
 */
export type Receipt = string | Record<string, string>;

export type IncomingStatus = {
  // new Date().toISOString(), or null to retract. `pending` is the arm bit
  // automation reads, and the column default sets it on every insert that
  // omits a status — so a writer describing something already finished (a
  // history replay of a months-old message) has to state the retraction, not
  // merely leave it out.
  pending?: string | null;
  read?: Receipt; // per-member map in team chat; scalar elsewhere
  typing?: string;
  edited?: string; // sender edited the message (Instagram, WhatsApp coexistence)
  deleted?: string; // sender deleted/revoked the message (Instagram, WhatsApp coexistence)
  preprocessing?: string;
  preprocessed?: string;
  errors?: string[]; // why a medium arrived as a media_placeholder
};

export type OutgoingStatus = {
  pending?: string | null; // as IncomingStatus: null retracts the arm bit
  held_for_quality_assessment?: string;
  accepted?: string;
  sent?: string;
  delivered?: Receipt; // per-participant map on external group messages
  read?: Receipt; // per-participant map on external group messages
  edited?: string; // sender edited the message (Instagram, WhatsApp coexistence)
  deleted?: string; // sender deleted/revoked the message (Instagram, WhatsApp coexistence)
  failed?: string;
  preprocessing?: string;
  preprocessed?: string;
  errors?: WebhookError[];
};

export type EndpointStatus = {
  messaging_product: "whatsapp";
  status: "read";
  message_id: string;
  typing_indicator?: {
    type: "text";
  };
};

export type EndpointStatusResponse = {
  success: true;
};
