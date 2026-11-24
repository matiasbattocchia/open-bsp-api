import type {
  Database as DatabaseGenerated,
  Json,
  Tables,
} from "../db_types.ts";
import { MergeDeep } from "https://esm.sh/type-fest@^4.11.1";
import type {
  IncomingMessage,
  InternalMessage,
  OutgoingMessage,
} from "./message_types.ts";
import type { IncomingStatus, OutgoingStatus } from "./status_types.ts";
import type { ConversationType } from "./conversation_types.ts";
import type {
  AIAgentExtra,
  ContactAddressExtra,
  ConversationExtra,
  HumanAgentExtra,
  OrganizationAddressExtra,
  OrganizationExtra,
} from "./extra_types.ts";

export type { Json, Tables };

type AgentExtra = AIAgentExtra & HumanAgentExtra;

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
            type: ConversationType | null;
            extra: ConversationExtra | null;
          };
          Insert: {
            type?: ConversationType;
            extra?: ConversationExtra;
          };
          Update: {
            type?: ConversationType;
            extra?: ConversationExtra;
          };
        };
        // There is no row-level discriminant. Who authored a row is
        // `sender_address` (a contact, or null = the account itself);
        // record-only rows carry `content.internal` (see
        // isInternal/isToolTrace). The content union is therefore plain:
        // narrow via content.type/kind, or via the guards.
        messages: {
          Row: {
            content: IncomingMessage | InternalMessage | OutgoingMessage;
            status: IncomingStatus | OutgoingStatus;
          };
          Insert: {
            conversation_id?: string;
            content: IncomingMessage | InternalMessage | OutgoingMessage;
            status?: IncomingStatus | OutgoingStatus;
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

export type ContactAddressRow =
  Database["public"]["Tables"]["contacts_addresses"]["Row"];
export type ContactAddressInsert =
  Database["public"]["Tables"]["contacts_addresses"]["Insert"];

export type AgentRow = Database["public"]["Tables"]["agents"]["Row"];

export type OrganizationAddressRow =
  Database["public"]["Tables"]["organizations_addresses"]["Row"];

export type ApiKeyRow = Database["public"]["Tables"]["api_keys"]["Row"];
