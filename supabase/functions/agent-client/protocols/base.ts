import type {
  AgentRow,
  MessageRow,
  MessageInsert,
  ConversationRow,
  OrganizationRow,
  ContactRow,
  AgentExtra,
} from "../../_shared/supabase.ts";

export type AgentRowWithExtra = Omit<AgentRow, "extra"> & {
  extra: AgentExtra;
};

export interface RequestContext {
  organization: OrganizationRow;
  conversation: ConversationRow;
  messages: MessageRow[];
  contact: ContactRow | null;
  agent: AgentRowWithExtra;
}

export interface ResponseContext {
  organization?: OrganizationRow;
  conversation?: ConversationRow;
  messages?: MessageInsert[];
  contact?: ContactRow;
  agent?: AgentRowWithExtra;
}

export interface AgentProtocolHandler<Request = unknown, Response = unknown> {
  prepareRequest(): Promise<Request>;

  sendRequest(request: Request): Promise<Response>;

  processResponse(response: Response): Promise<ResponseContext>;
}
