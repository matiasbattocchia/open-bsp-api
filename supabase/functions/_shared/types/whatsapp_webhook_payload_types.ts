import type { WebhookStatus } from "./status_types.ts";
import type {
  IncomingContextInfo,
  WebhookMessageBase,
} from "./whatsapp_webhook_message_types.ts";

// System/app/account-level, statuses and history error structure
export type WebhookError = {
  code: number;
  title: string;
  message: string;
  error_data: {
    details: string;
  };
  href: string;
};

// This is what Supabase webhooks send to functions
export type WebhookPayload<Record> = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record | null;
  old_record: Record | null;
};

//===================================
// Meta Webhook Payload Types
//===================================

/**
 * Errors
 *
 * Errors in messages webhooks can be surfaced in four places:
 *
 * - System-, app-, and account-level errors appear as a value object property (entry.changes.value.errors). See the errors reference.
 * - Incoming message errors appear in the messages array (entry.changes.value.messages[].errors). These webhooks have type set to unsupported. See the unsupported reference.
 * - Outgoing message errors appear in the statuses array (entry.changes.value.statuses[].errors). See the status reference.
 * - History error, when history is declined (entry.changes.value.history[].errors).
 */

// Base metadata that appears in all webhook values
export type WebhookMetadata = {
  display_phone_number: string;
  phone_number_id: string;
};

// Contact profile information
export type WebhookContact = {
  profile: {
    name: string;
    username?: string; // The user's WhatsApp username, when adopted.
  };
  wa_id?: string; // Phone number. Omitted for username-only users outside the
  // 30-day interaction window / not in the contact book (see BSUID migration).
  user_id: string; // Business-scoped user ID (BSUID), e.g. "US.13491208...".
  // Always present in webhooks since April 2026, even without a username.
  parent_user_id?: string; // Parent BSUID; only if parent BSUIDs are enabled.
  identity_key_hash?: string; // only included if identity change check enabled
};

export type WebhookIncomingMessage = WebhookMessageBase & IncomingContextInfo;

export type WebhookValueMessages = {
  messaging_product: "whatsapp";
  metadata?: WebhookMetadata;
  contacts: WebhookContact[];
  messages: WebhookIncomingMessage[];
};

export type WebhookValueMessagesError = {
  messaging_product: "whatsapp";
  metadata: WebhookMetadata;
  errors: WebhookError[]; // System/app/account-level errors
};

// Value type for message statuses (sent/delivered/read/failed)
export type WebhookValueStatuses = {
  messaging_product: "whatsapp";
  metadata: WebhookMetadata;
  contacts?: WebhookContact[]; // Included for sent/delivered/read; omitted for failed.
  statuses: WebhookStatus[];
};

export type WebhookEchoMessage = WebhookMessageBase & {
  to?: string; // Recipient phone number. May be omitted for username-only users.
  to_user_id: string; // Recipient business-scoped user ID (BSUID).
  to_parent_user_id?: string; // Recipient parent BSUID; only if enabled.
};

// Value type for SMB message echoes
export type WebhookValueMessageEchoes = {
  messaging_product: "whatsapp";
  metadata: WebhookMetadata;
  contacts?: WebhookContact[];
  message_echoes: WebhookEchoMessage[];
};

// History metadata
export type WebhookHistoryMetadata = {
  phase: 0 | 1 | 2;
  chunk_order: number;
  progress: number;
};

export type WebhookHistoryMessage = WebhookMessageBase & {
  // SMB message echoes only. The threaded-history docs show just `to`, but the
  // BSUID identifiers are likely omitted there by mistake (every other echo
  // webhook carries them), so we accept them defensively.
  to?: string; // recipient phone number
  to_user_id?: string; // recipient BSUID
  to_parent_user_id?: string; // recipient parent BSUID
  history_context: {
    status: "DELIVERED" | "ERROR" | "PENDING" | "PLAYED" | "READ" | "SENT";
  };
};

// History thread containing messages
export type WebhookHistoryThread = {
  id?: string; // User phone number; omitted for username users w/o available phone.
  context: { // The contact this thread/conversation is with.
    wa_id?: string; // User phone number, when available.
    user_id: string; // Business-scoped user ID (BSUID).
    parent_user_id?: string; // Only if parent BSUIDs are enabled.
    username?: string; // Only if the user has adopted a username.
  };
  messages: WebhookHistoryMessage[];
};

// Value type for history webhooks
export type WebhookValueHistory = {
  messaging_product: "whatsapp";
  metadata: WebhookMetadata;
  history: Array<{
    metadata: WebhookHistoryMetadata;
    threads: WebhookHistoryThread[];
  }>;
};

export type WebhookValueHistoryError = {
  messaging_product: "whatsapp";
  metadata: WebhookMetadata;
  history: Array<{
    errors: Omit<WebhookError, "href">[];
  }>;
};

// History webhook variant describing individual media assets rather than full
// threads. Shaped like a messages/smb_message_echoes payload: user → business
// arrives in `messages`, business → user in `message_echoes`.
export type WebhookValueHistoryMedia = {
  messaging_product: "whatsapp";
  metadata: WebhookMetadata;
  contacts?: WebhookContact[];
  messages?: WebhookIncomingMessage[];
  message_echoes?: WebhookEchoMessage[];
};

// State sync types (contact sync)
export type WebhookStateSyncContact = {
  full_name: string; // not included when removed
  first_name: string; // not included when removed
  phone_number?: string; // Can be omitted for username users without an
  // available phone number (see BSUID migration).
  user_id: string; // Business-scoped user ID (BSUID).
  parent_user_id?: string; // Only if parent BSUIDs are enabled.
  username?: string; // Only if the user has enabled the username feature.
};

export type WebhookStateSyncItem = {
  type: "contact";
  contact: WebhookStateSyncContact;
  action: "add" | "remove";
  metadata: {
    timestamp: string;
  };
};

export type WebhookValueStateSync = {
  messaging_product: "whatsapp";
  metadata: WebhookMetadata;
  state_sync: WebhookStateSyncItem[];
};

// Account update webhook types
export type WebhookAccountUpdate_Account = {
  event: "ACCOUNT_DELETED";
  waba_info: {
    waba_id: string;
    owner_business_id: string;
  };
};

export type WebhookAccountUpdate_PartnerApp = {
  event: "PARTNER_APP_INSTALLED" | "PARTNER_APP_UNINSTALLED";
  waba_info: {
    waba_id: string;
    owner_business_id: string;
    partner_app_id: string;
  };
};

export type WebhookAccountUpdate_Partner = {
  event: "PARTNER_ADDED" | "PARTNER_REMOVED";
  waba_info: {
    waba_id: string;
    owner_business_id: string;
  };
};

// Coexistence lifecycle events. These payloads carry only `event` (no
// waba_info); the WABA ID is found in entry.id instead.
export type WebhookAccountUpdate_Coexistence = {
  event: "ACCOUNT_OFFBOARDED" | "ACCOUNT_RECONNECTED";
};

export type WebhookAccountUpdateValue =
  | WebhookAccountUpdate_Account
  | WebhookAccountUpdate_PartnerApp
  | WebhookAccountUpdate_Partner
  | WebhookAccountUpdate_Coexistence;

// Value type for user_id_update webhooks (a user's BSUID changed).
export type WebhookUserIdUpdate = {
  wa_id?: string; // User phone number, when available.
  detail: string; // Human-readable description of the update.
  user_id: {
    previous: string; // Old BSUID.
    current: string; // New BSUID.
  };
  parent_user_id?: { // Only if parent BSUIDs are enabled.
    previous: string;
    current: string;
  };
  timestamp: string;
};

export type WebhookValueUserIdUpdate = {
  messaging_product: "whatsapp";
  metadata: WebhookMetadata;
  contacts?: WebhookContact[];
  user_id_update: WebhookUserIdUpdate[];
};

// Change object that discriminates based on field value
export type WebhookChange =
  | {
    field: "messages";
    value:
      | WebhookValueMessages // incoming
      | WebhookValueStatuses // outgoing
      | WebhookValueMessagesError; // error
  }
  | {
    field: "smb_message_echoes";
    value: WebhookValueMessageEchoes; // outgoing messages from connected devices
  }
  | {
    field: "history";
    value:
      | WebhookValueHistory
      | WebhookValueHistoryError // when history is declined
      | WebhookValueHistoryMedia; // flat media-asset history payload
  }
  | {
    field: "smb_app_state_sync";
    value: WebhookValueStateSync; // contact sync events
  }
  | {
    field: "account_update";
    value: WebhookAccountUpdateValue;
  }
  | {
    field: "user_id_update";
    value: WebhookValueUserIdUpdate;
  };

// Entry object that contains one or more changes
export type WebhookEntry = {
  id: string; // WhatsApp Business Account ID
  time: number; // Unix timestamp
  changes: WebhookChange[];
};

// Complete Meta Webhook Payload
export type MetaWebhookPayload = {
  object: "whatsapp_business_account";
  entry: WebhookEntry[];
};
