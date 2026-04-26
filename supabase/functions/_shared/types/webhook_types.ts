import type { WebhookError } from "./webhook_error.ts";
import type { WebhookStatus } from "./status_types.ts";
import type {
  IncomingContextInfo,
  WebhookMessageBase,
} from "./whatsapp_incoming_message_types.ts";

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
  profile?: {
    name: string;
  };
  wa_id: string;
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
  statuses: WebhookStatus[];
};

export type WebhookEchoMessage = WebhookMessageBase & {
  to: string;
};

// Value type for SMB message echoes
export type WebhookValueMessageEchoes = {
  messaging_product: "whatsapp";
  metadata: WebhookMetadata;
  message_echoes: WebhookEchoMessage[];
};

// History metadata
export type WebhookHistoryMetadata = {
  phase: 0 | 1 | 2;
  chunk_order: number;
  progress: number;
};

export type WebhookHistoryMessage = WebhookMessageBase & {
  to?: string; // only included if SMB message echo,
  history_context: {
    status: "DELIVERED" | "ERROR" | "PENDING" | "PLAYED" | "READ" | "SENT";
  };
};

// History thread containing messages
export type WebhookHistoryThread = {
  id: string; // WhatsApp user phone number
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

// State sync types (contact sync)
export type WebhookStateSyncContact = {
  full_name: string; // not included when removed
  first_name: string; // not included when removed
  phone_number: string;
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

export type WebhookAccountUpdateValue =
  | WebhookAccountUpdate_Account
  | WebhookAccountUpdate_PartnerApp
  | WebhookAccountUpdate_Partner;

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
    value: WebhookValueHistory | WebhookValueHistoryError; // when history is declined
  }
  | {
    field: "smb_app_state_sync";
    value: WebhookValueStateSync; // contact sync events
  }
  | {
    field: "account_update";
    value: WebhookAccountUpdateValue;
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
