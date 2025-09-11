import { z } from "zod";
import type { Json } from "../../_shared/db_types.ts";
import type { RequestContext } from "../protocols/base.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ToolDefinition<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
  Config = void
> = {
  provider: "local";
  type: "function" | "custom" | "sql" | "http" | "mcp";
  name: string;
  description?: string;
  inputSchema: z.core.JSONSchema.BaseSchema; // TODO: "custom" does not need input schema
  outputSchema: z.core.JSONSchema.BaseSchema;
  implementation: Config extends Json
    ? (
        input: z.infer<InputSchema>,
        config: Config,
        context: RequestContext,
        supabaseClient: SupabaseClient
      ) => Promise<z.infer<OutputSchema>>
    : (input: z.infer<InputSchema>) => Promise<z.infer<OutputSchema>>;
};
