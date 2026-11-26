import type {
  AgentRow,
  AIAgentExtra,
  ConversationRow,
  MessageInsert,
  MessageRow,
  OrganizationRow,
  Part,
} from "../../_shared/supabase.ts";
import { isInternal, isToolTrace } from "../../_shared/supabase.ts";

// The peer as the protocol handlers care about it: a display name resolved
// from the conversation's contacts_addresses row (or the author agent on a
// local DM).
export interface ContactInfo {
  name?: string;
}

export type AgentRowWithExtra = Omit<AgentRow, "extra"> & {
  extra: AIAgentExtra;
};

export interface RequestContext {
  organization: OrganizationRow;
  conversation: ConversationRow;
  messages: MessageRow[];
  contact?: ContactInfo;
  agent: AgentRowWithExtra;
}

export interface ResponseContext {
  organization?: OrganizationRow;
  conversation?: ConversationRow;
  messages?: MessageInsert[];
  agent?: AgentRowWithExtra;
}

/**
 * The tool name as the model meant it, not as the provider spelled it.
 * gpt-oss (harmony) leaks its own framing into the name it emits — a
 * `functions.` namespace prefix, or a trailing `<|channel|>commentary`
 * marker — and matching those literally drops the call on the floor: the
 * answer the model wrote is recorded as a call to a tool nobody has, and the
 * user gets silence.
 *
 * A no-op on a well-behaved name, so it costs nothing to run on every call.
 */
export function normalizeToolName(name: string): string {
  return name.split("<|")[0].trim().replace(/^functions\./, "");
}

/**
 * A turn that failed leaves its error as an internal text row of the agent's
 * own (tool traces are the agent's other internal rows). It goes back to the
 * model as a note, not as the agent's words: the contact got nothing, so the
 * message before it is still unanswered.
 */
export function failedTurnNote(
  row: MessageRow,
  agentId: string,
): string | undefined {
  if (row.agent_id !== agentId || !isInternal(row) || isToolTrace(row)) {
    return;
  }

  const part = row.content as Part;

  if (part.type !== "text") return;

  return `<error>This reply failed and the contact did not get it: ${part.text}</error>`;
}

export function contextHeaders(
  context: RequestContext,
): Record<string, string> {
  return {
    "organization-id": context.organization.id,
    "organization-address": context.conversation.organization_address,
    "conversation-id": context.conversation.id,
    "agent-id": context.agent.id,
    // Header name kept for the agent APIs that already read it; the value is
    // the conversation's address, which says the same thing for a direct chat
    // and something truthful for a group.
    ...(context.conversation.address &&
      { "contact-address": context.conversation.address }),
  };
}

export interface AgentProtocolHandler<Request = unknown, Response = unknown> {
  prepareRequest(): Promise<Request>;

  sendRequest(request: Request): Promise<Response>;

  processResponse(response: Response): Promise<ResponseContext>;
}
