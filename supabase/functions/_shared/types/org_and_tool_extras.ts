import type { Database as DatabaseGenerated } from "../db_types.ts";
import type { SQLToolConfig } from "../../agent-client/tools/sql.ts";

//===================================
// Extra
//===================================

export type Memory = {
  [key: string]: string | undefined | Memory;
};

export type PreprocessingConfig = {
  mode?: "active" | "inactive";
  model?: "gemini-2.5-pro" | "gemini-2.5-flash";
  api_key?: string;
  language?: string;
  extra_prompt?: string;
};

export type OrganizationExtra = {
  response_delay_seconds?: number;
  welcome_message?: string;
  authorized_contacts_only?: boolean;
  default_agent_id?: string;
  media_preprocessing?: PreprocessingConfig;
  error_messages_direction?: "internal" | "outgoing";
};

export type OrganizationAddressExtra = {
  waba_id?: string;
  phone_number?: string;
  verified_name?: string;
  access_token?: string;
  flow_type?: "only_waba" | "new_phone_number" | "existing_phone_number";
};

export type ConversationExtra = {
  memory?: Memory;
  paused?: string;
  archived?: string;
  pinned?: string;
  default_agent_id?: string;
  /*
  test_run?: {
    reference_conversation: {
      organization_address: string;
      contact_address: string;
    };
    status?: "fail" | "success";
    reference_message_id?: string;
  };
  */
};

export type ContactExtra = Record<PropertyKey, never>;

export type ContactAddressExtra = {
  name?: string;
  synced?: { // if the contact address was synced from WhatsApp
    name: string;
    action: "add" | "remove";
  }
  replaces_address?: string;
  replaced_by_address?: string;
}

// Function tools have a JSON input (data part).
export type LocalFunctionToolConfig = {
  provider: "local";
  type: "function";
  name: string;
};

// Custom tools have a free-grammar input (text part).
export type LocalCustomToolConfig = {
  provider: "local";
  type: "custom";
  name: string;
};

export type LocalSimpleToolConfig =
  | LocalFunctionToolConfig
  | LocalCustomToolConfig;

export type LocalMCPToolConfig = {
  provider: "local";
  type: "mcp";
  label: string; // server label
  config: {
    url: string;
    product?: "calendar" | "sheets";
    headers?: Record<string, string>;
    allowed_tools?: string[];
    files?: string[];
    email?: string;
  };
};

export type LocalSQLToolConfig = {
  provider: "local";
  type: "sql";
  label: string; // database label
  config: SQLToolConfig;
};

export type LocalHTTPToolConfig = {
  provider: "local";
  type: "http";
  label: string; // client label
  config: {
    headers?: Record<string, string>;
    url?: string;
    methods?: string[];
  };
};

export type LocalSpecialToolConfig = LocalSQLToolConfig | LocalHTTPToolConfig;

export type ToolConfig =
  | LocalSimpleToolConfig
  | LocalSpecialToolConfig
  | LocalMCPToolConfig;

export type HumanAgentExtra = {
  role: DatabaseGenerated["public"]["Enums"]["role"];
  invitation?: {
    organization_name: string;
    email: string;
    status: "pending" | "accepted" | "rejected";
  };
};

export type AIAgentExtra = {
  mode?: "active" | "draft" | "inactive";
  description?: string;
  api_url?: string;
  api_key?: string;
  model?: string;
  // TODO: Add responses (openai), messages (anthropic), generate-content (google).
  protocol?: "a2a" | "chat_completions";
  max_messages?: number;
  temperature?: number;
  max_tokens?: number;
  thinking?: "minimal" | "low" | "medium" | "high";
  instructions?: string;
  send_inline_files_up_to_size_mb?: number;
  tools?: ToolConfig[];
};
