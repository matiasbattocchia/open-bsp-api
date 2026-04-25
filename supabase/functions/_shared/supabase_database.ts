import type { Database as DatabaseGenerated, Json, Tables } from "./db_types.ts";
import { MergeDeep } from "https://esm.sh/type-fest@^4.11.1";
import type { IncomingMessage, InternalMessage, OutgoingMessage } from "./protocol_message_types.ts";
import type { IncomingStatus, OutgoingStatus } from "./status_types.ts";
import type {
  AIAgentExtra,
  ContactAddressExtra,
  ContactExtra,
  ConversationExtra,
  HumanAgentExtra,
  OrganizationAddressExtra,
  OrganizationExtra,
} from "./org_and_tool_extras.ts";

export type { Json, Tables };

type AgentExtra = HumanAgentExtra | AIAgentExtra;

export type Database = MergeDeep<
  DatabaseGenerated,
  {
    public: {
      Tables: {
        organizations: {
          Row: {
            extra: OrganizationExtra | null;
          };
          Insert: {
            extra?: OrganizationExtra;
          };
          Update: {
            extra?: OrganizationExtra;
          };
        };
        organizations_addresses: {
          Row: {
            extra: OrganizationAddressExtra | null;
          };
          Insert: {
            extra?: OrganizationAddressExtra;
          };
          Update: {
            extra?: OrganizationAddressExtra;
          };
        };
        conversations: {
          Row: {
            extra: ConversationExtra | null;
          };
          Insert: {
            extra?: ConversationExtra;
          };
          Update: {
            extra?: ConversationExtra;
          };
        };
        messages: {
          Row:
          | {
            direction: "incoming";
            content: IncomingMessage;
            status: IncomingStatus;
          }
          | {
            direction: "internal";
            content: InternalMessage;
            status: IncomingStatus;
          }
          | {
            direction: "outgoing";
            content: OutgoingMessage;
            status: OutgoingStatus;
          };
          Insert:
          | {
            conversation_id?: string;
            direction: "incoming";
            content: IncomingMessage;
            status?: IncomingStatus;
          }
          | {
            conversation_id?: string;
            direction: "internal";
            content: InternalMessage;
            status?: IncomingStatus;
          }
          | {
            conversation_id?: string;
            direction: "outgoing";
            content: OutgoingMessage;
            status?: OutgoingStatus;
          };
        };
        contacts: {
          Row: {
            extra: ContactExtra | null;
          };
          Insert: {
            extra?: ContactExtra;
          };
          Update: {
            extra?: ContactExtra;
          };
        };
        contacts_addresses: {
          Row: {
            extra: ContactAddressExtra | null;
          };
          Insert: {
            extra?: ContactAddressExtra;
          };
          Update: {
            extra?: ContactAddressExtra;
          };
        };
        agents: {
          Row: {
            extra: AgentExtra | null;
          };
          Insert: {
            extra?: AgentExtra;
          };
          Update: {
            extra?: AgentExtra;
          };
        };
      };
    };
  }
>;

export type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
export type MessageInsert = Database["public"]["Tables"]["messages"]["Insert"];
export type MessageUpdate = Database["public"]["Tables"]["messages"]["Update"];

export type ConversationRow =
  Database["public"]["Tables"]["conversations"]["Row"];

export type OrganizationRow =
  Database["public"]["Tables"]["organizations"]["Row"];

export type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];
export type ContactInsert = Database["public"]["Tables"]["contacts"]["Insert"];

export type ContactAddressRow =
  Database["public"]["Tables"]["contacts_addresses"]["Row"];
export type ContactAddressInsert =
  Database["public"]["Tables"]["contacts_addresses"]["Insert"];

export type AgentRow = Database["public"]["Tables"]["agents"]["Row"];

export type OrganizationAddressRow =
  Database["public"]["Tables"]["organizations_addresses"]["Row"];

export type ApiKeyRow = Database["public"]["Tables"]["api_keys"]["Row"];
