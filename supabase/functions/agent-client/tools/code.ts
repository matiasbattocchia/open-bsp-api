import { z } from "zod";
import type { ToolDefinition } from "./base.ts";

const CodeExecutionConfigSchema = z.object({
  api_key: z.string().describe("E2B API key"),
});

const CodeExecutionInputSchema = z.object({});

const CodeExecutionOutputSchema = z.object({});

export async function codeExecutionImplementation(
  _input: z.infer<typeof CodeExecutionInputSchema>
): Promise<z.infer<typeof CodeExecutionOutputSchema>> {
  return {};
}
