import type { WebhookError } from "./webhook_error.ts";

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
  recipient_id: string; // User phone number or group ID
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

export type IncomingStatus = {
  pending?: string; // new Date().toISOString()
  read?: string;
  typing?: string;
  preprocessing?: string;
  preprocessed?: string;
};

export type OutgoingStatus = {
  pending?: string; // new Date().toISOString()
  held_for_quality_assessment?: string;
  accepted?: string;
  sent?: string;
  delivered?: string;
  read?: string;
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
