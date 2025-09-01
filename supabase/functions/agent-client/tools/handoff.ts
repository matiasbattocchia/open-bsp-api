import { z } from "zod";
import type { ToolDefinition } from "./base.ts";

const TransferToHumanAgentInputSchema = z.object({});

const TransferToHumanAgentOutputSchema = z.object({});

export async function transferToHumanAgentImplementation(
  _input: z.infer<typeof TransferToHumanAgentInputSchema>
): Promise<z.infer<typeof TransferToHumanAgentOutputSchema>> {
  return {};
}

export const TransferToHumanAgentTool: ToolDefinition<
  typeof TransferToHumanAgentInputSchema,
  typeof TransferToHumanAgentOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "transfer_to_human_agent",
  description: "Transfer the conversation to a human agent.",
  inputSchema: z.toJSONSchema(TransferToHumanAgentInputSchema),
  outputSchema: z.toJSONSchema(TransferToHumanAgentOutputSchema),
  implementation: transferToHumanAgentImplementation,
};
