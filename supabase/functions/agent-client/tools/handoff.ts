import { z } from "zod";
import type { ToolDefinition } from "./base.ts";
import type { RequestContext } from "../protocols/base.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ConversationExtra,
  Database,
  InternalMessage,
  MessageInsert,
} from "../../_shared/supabase.ts";

const TransferToHumanAgentInputSchema = z.object({
  reason: z.string().optional().describe(
    "Brief reason the conversation needs human help.",
  ),
  note: z.string().optional().describe(
    "Optional extra context for the human operator.",
  ),
});

const TransferToHumanAgentOutputSchema = z.object({
  status: z.literal("requested"),
  conversation_id: z.string(),
  requested_at: z.string(),
});

export async function transferToHumanAgentImplementation(
  input: z.infer<typeof TransferToHumanAgentInputSchema>,
  context: RequestContext,
  supabaseClient: SupabaseClient<Database>,
): Promise<z.infer<typeof TransferToHumanAgentOutputSchema>> {
  const requestedAt = new Date().toISOString();
  const handoff: NonNullable<ConversationExtra["handoff"]> = {
    status: "requested",
    requested_at: requestedAt,
    requested_by_agent_id: context.agent.id,
    ...(input.reason && { reason: input.reason }),
    ...(input.note && { note: input.note }),
  };

  await supabaseClient
    .from("conversations")
    .update({
      extra: {
        paused: requestedAt,
        handoff,
      },
    })
    .eq("id", context.conversation.id)
    .throwOnError();

  const auditContent: InternalMessage = {
    version: "1",
    type: "data",
    kind: "data",
    data: {
      event: "human_handoff_requested",
      handoff,
    },
    text: input.reason || "Human handoff requested.",
  };

  const auditMessage: MessageInsert = {
    organization_id: context.organization.id,
    conversation_id: context.conversation.id,
    service: context.conversation.service,
    organization_address: context.conversation.organization_address,
    contact_address: context.conversation.contact_address,
    group_address: context.conversation.group_address,
    direction: "internal",
    agent_id: context.agent.id,
    content: auditContent,
    timestamp: requestedAt,
  };

  await supabaseClient
    .from("messages")
    .insert(auditMessage)
    .throwOnError();

  return {
    status: "requested",
    conversation_id: context.conversation.id,
    requested_at: requestedAt,
  };
}

export const TransferToHumanAgentTool: ToolDefinition<
  typeof TransferToHumanAgentInputSchema,
  typeof TransferToHumanAgentOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "transfer_to_human_agent",
  description:
    "Request human help for the current conversation. This pauses AI automation and records a handoff note for operators.",
  inputSchema: z.toJSONSchema(TransferToHumanAgentInputSchema),
  outputSchema: z.toJSONSchema(TransferToHumanAgentOutputSchema),
  implementation: transferToHumanAgentImplementation,
};
