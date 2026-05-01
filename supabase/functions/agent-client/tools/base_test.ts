import { CalculatorTool } from "./calculator.ts";
import type { RequestContext } from "../protocols/base.ts";
import type { Database } from "../../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const context = {
  organization: { id: "org-1" },
  conversation: { id: "conv-1" },
  messages: [],
  agent: { id: "agent-1" },
} as unknown as RequestContext;

Deno.test("local function tools accept request context and Supabase client", async () => {
  const result = await CalculatorTool.implementation(
    { expression: "2 + 3" },
    context,
    {} as SupabaseClient<Database>,
  );

  if (result.result !== 5) {
    throw new Error(`Expected calculator result 5, got ${result.result}`);
  }
});
