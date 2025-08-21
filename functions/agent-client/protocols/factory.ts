import type { AgentProtocolHandler, RequestContext } from "./base.ts";
import { ChatCompletionsHandler } from "./chat-completions.ts";
import { A2AHandler } from "./a2a.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentTool } from "../index.ts";

export class ProtocolFactory {
  static getHandler(
    context: RequestContext,
    client: SupabaseClient,
    tools: AgentTool[]
  ): AgentProtocolHandler {
    const protocol = context.agent.extra.protocol || "chat_completions";

    switch (protocol) {
      case "chat_completions":
        return new ChatCompletionsHandler(context, client, tools);
      case "a2a":
        return new A2AHandler(context, client);
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }
}
