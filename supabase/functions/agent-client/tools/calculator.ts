import { evaluate } from "mathjs";
import { z } from "zod";
import type { ToolDefinition } from "./base.ts";

const CalculatorInputSchema = z.object({
  expression: z.string().describe("Mathematical expression to evaluate."),
});

const CalculatorOutputSchema = z.object({
  result: z.number().describe("The result of the expression."),
});

export async function calculatorToolImplementation(
  input: z.infer<typeof CalculatorInputSchema>
): Promise<z.infer<typeof CalculatorOutputSchema>> {
  const result = await evaluate(input.expression);

  return { result };
}

export const CalculatorTool: ToolDefinition<
  typeof CalculatorInputSchema,
  typeof CalculatorOutputSchema
> = {
  provider: "local",
  type: "function", // TODO: Should be "custom" but Claude / Gemini does not support it yet.
  name: "calculator",
  description:
    'Computes the result of simple mathematical expressions using the Math.js library. Handles basic arithmetic operations like addition, subtraction, multiplication, division, exponentiation, and common functions like sin, cos, abs, exp, and random. Example expressions: "1.2 * (2 + 4.5)", "12.7 cm to inch", "sin(45 deg) ^ 2".',
  inputSchema: z.toJSONSchema(CalculatorInputSchema),
  outputSchema: z.toJSONSchema(CalculatorOutputSchema),
  implementation: calculatorToolImplementation,
};
