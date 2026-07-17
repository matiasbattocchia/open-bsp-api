import OpenAI from "openai";
import type {
  LocalToolInfo,
  MessageInsert,
  MessageRow,
  Part,
  ToolEventInfo,
  ToolInfo,
} from "../../_shared/supabase.ts";
import {
  type AgentProtocolHandler,
  contextHeaders,
  type RequestContext,
  type ResponseContext,
} from "./base.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentTool } from "../index.ts";
import * as log from "../../_shared/logger.ts";
import { getFileMetadata } from "../../_shared/media.ts";
import { serializePartAsXML } from "./serializer.ts";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { inspect } from "node:util";
dayjs.extend(utc);

// Handler for the Open Responses protocol (https://openresponses.org), the
// standardized, multi-vendor successor to OpenAI's Responses API. Mirrors
// ChatCompletionsHandler; the differences are that Responses represents each
// tool call as its own `function_call` input item (no merging), tool results as
// `function_call_output` items keyed by `call_id`, and returns an array of
// output items instead of a single message.
//
// Like the chat-completions handler, this is STATELESS: the full conversation
// is rebuilt from the DB on every turn and passed as `input` (no
// `previous_response_id` / server-side state), matching the agent-client loop.

// Convenience aliases for the OpenAI SDK's Responses namespace (avoids adding
// import-map entries for openai/resources/responses).
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseOutputItem = OpenAI.Responses.ResponseOutputItem;
type ResponsesTool = OpenAI.Responses.Tool;
type FunctionCallItem = OpenAI.Responses.ResponseFunctionToolCall;
type ResponsesResponse = OpenAI.Responses.Response;

const MULTI_MESSAGE_RESPONSE = true;
const RESPOND_FUNCTION_NAME = "respond";

const RESPOND_TOOL: ResponsesTool = {
  type: "function",
  name: RESPOND_FUNCTION_NAME,
  description:
    "Default tool. Always call this to send messages to the user, unless you need to call another tool first. Call with an empty messages array to skip responding.",
  strict: false,
  parameters: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: {
                type: { type: "string", enum: ["text"] },
                text: { type: "string" },
              },
              required: ["type", "text"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { type: "string", enum: ["file"] },
                uri: { type: "string", description: "internal:// file URI" },
                name: { type: "string" },
                text: { type: "string", description: "Optional caption" },
              },
              required: ["type", "uri"],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    additionalProperties: false,
  },
};

export interface ResponsesRequest {
  input: ResponseInputItem[];
  tools: ResponsesTool[];
  instructions: string;
}

export interface ResponsesResponseWrapper {
  output: ResponseOutputItem[];
}

export class ResponsesHandler
  implements AgentProtocolHandler<ResponsesRequest, ResponsesResponseWrapper> {
  private tools: AgentTool[];
  private context: RequestContext;
  private client: SupabaseClient;
  private FUNCTION_NAME_SEPARATOR = "__";
  private messagesByExternalId = new Map<string, MessageRow>();

  constructor(
    tools: AgentTool[],
    context: RequestContext,
    client: SupabaseClient,
  ) {
    this.tools = tools;
    this.context = context;
    this.client = client;
  }

  /**
   * A tool-use item must be followed by its matching tool-result item. The
   * result rows are not guaranteed to arrive in order, so group each task's
   * uses before its results.
   */
  private sortToolMessages(messages: MessageRow[]): MessageRow[] {
    const taskMap = new Map<
      string,
      { uses: MessageRow[]; results: MessageRow[] }
    >();

    const withoutTools: MessageRow[] = [];

    for (const row of messages) {
      if (row.direction === "internal" && row.content.tool) {
        const taskId = row.content.task?.id;

        if (!taskId) {
          throw new Error("Task id is required");
        }

        let task = taskMap.get(taskId);

        if (!task) {
          task = { uses: [], results: [] };
          taskMap.set(taskId, task);
        }

        if (row.content.tool.event === "use") {
          if (!task.uses.length) {
            // First appearance of a use within a task acts as a placeholder.
            withoutTools.push(row);
          }

          task.uses.push(row);
        } else {
          task.results.push(row);
        }

        continue;
      }

      withoutTools.push(row);
    }

    const sorted: MessageRow[] = [];

    for (const row of withoutTools) {
      if (row.direction === "internal" && row.content.tool) {
        const taskId = row.content.task!.id;
        const task = taskMap.get(taskId)!;

        sorted.push(...task.uses, ...task.results);

        continue;
      }

      sorted.push(row);
    }

    return sorted;
  }

  private removeUnpairedToolMessages(messages: MessageRow[]): MessageRow[] {
    const toolUseSet = new Set<string>();
    const pairedToolUseSet = new Set<string>();

    for (const message of messages) {
      if (message.direction === "internal" && message.content.tool) {
        const toolUseId = message.content.tool.use_id;

        if (toolUseSet.has(toolUseId)) {
          pairedToolUseSet.add(toolUseId);
        } else {
          toolUseSet.add(toolUseId);
        }
      }
    }

    return messages.filter((message) => {
      if (message.direction === "internal" && message.content.tool) {
        return pairedToolUseSet.has(message.content.tool.use_id);
      }

      return true;
    });
  }

  /**
   * Map one stored message row to a Responses input item.
   *
   * Unlike Chat Completions (which merges parallel tool calls into a single
   * assistant message), Responses represents each tool call as its own
   * `function_call` item and each result as a `function_call_output` item, both
   * keyed by `call_id`. History is text-only (no re-sent files) to keep the
   * request cheap over a long conversation.
   */
  private toResponseInput(row: MessageRow): ResponseInputItem {
    const part = row.content as Part & ToolInfo;
    const role = row.agent_id === this.context.agent.id ? "assistant" : "user";

    if (part.tool?.provider === "local") {
      const name = ["label" in part.tool && part.tool.label, part.tool.name]
        .filter(Boolean)
        .join(this.FUNCTION_NAME_SEPARATOR);

      if (part.tool.event === "use") {
        const args = part.type === "data"
          ? JSON.stringify(part.data)
          : part.type === "text"
          ? part.text
          : "";

        return {
          type: "function_call",
          call_id: part.tool.use_id,
          name,
          arguments: args,
        };
      }

      if (part.tool.event === "result") {
        const output = part.type === "data"
          ? JSON.stringify(part.data)
          : part.type === "text"
          ? part.text
          : "";

        return {
          type: "function_call_output",
          call_id: part.tool.use_id,
          output,
        };
      }
    }

    let serialized = serializePartAsXML(part);

    if (row.content.re_message_id) {
      const refMessage = this.messagesByExternalId.get(
        row.content.re_message_id,
      );

      if (refMessage) {
        const tag = part.type === "text" && part.kind === "reaction"
          ? "in-reaction-to"
          : "in-reply-to";
        const snippet = serializePartAsXML(
          refMessage.content as Part & ToolInfo,
        );
        serialized = `<${tag}>${snippet}</${tag}>\n${serialized}`;
      }
    }

    return { role, content: serialized };
  }

  prepareRequest(): Promise<ResponsesRequest> {
    let { messages, agent } = this.context;

    const max = agent.extra.max_messages;

    if (max && messages.length > max) {
      messages = messages.slice(-max);
    }

    // Build external_id index for reply/reaction context resolution.
    this.messagesByExternalId = new Map(
      messages
        .filter((m): m is MessageRow & { external_id: string } =>
          !!m.external_id
        )
        .map((m) => [m.external_id, m]),
    );

    messages = this.removeUnpairedToolMessages(messages);
    messages = this.sortToolMessages(messages);

    const input: ResponseInputItem[] = messages.map((row) =>
      this.toResponseInput(row)
    );

    // Runtime context, delivered via the `instructions` field (the Responses
    // analog of Chat Completions' leading system message).
    const contextInfo = {
      now: dayjs.utc().format("dddd, YYYY-MM-DD HH:mm [UTC]"),
      user: {
        name: this.context.contact?.name,
        phone: this.context.conversation.contact_address
          ? "+" + this.context.conversation.contact_address
          : undefined,
      },
    };

    let instructions = inspect(contextInfo, {
      compact: false,
      depth: Infinity,
      colors: false,
    });

    if (agent.extra.instructions) {
      instructions = agent.extra.instructions + "\n\n" + instructions;
    }

    const tools: ResponsesTool[] = this.tools.map((tool) => ({
      type: "function" as const,
      name: ["label" in tool && tool.label, tool.name]
        .filter(Boolean)
        .join(this.FUNCTION_NAME_SEPARATOR),
      description: tool.description,
      strict: false,
      parameters: tool.inputSchema as Record<string, unknown>,
    }));

    if (MULTI_MESSAGE_RESPONSE) {
      tools.push(RESPOND_TOOL);
    }

    return Promise.resolve({ input, tools, instructions });
  }

  private calculateCost(
    usage: ResponsesResponse["usage"],
    pricing: Record<string, number>,
    quantity: number,
  ): number {
    if (!usage) return 0;

    // Responses usage shape differs from Chat Completions: input_tokens /
    // output_tokens, with cached and reasoning in the *_tokens_details.
    const prompt = usage.input_tokens ?? 0;
    const completion = usage.output_tokens ?? 0;
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;

    const cost = (prompt - cached) * (pricing.input ?? 0) +
      cached * (pricing.cache_read ?? pricing.input ?? 0) +
      (completion - reasoning) * (pricing.output ?? 0) +
      reasoning * (pricing.reasoning ?? pricing.output ?? 0);

    return cost / quantity;
  }

  async sendRequest(
    request: ResponsesRequest,
  ): Promise<ResponsesResponseWrapper> {
    const { agent, organization } = this.context;

    let provider = agent.extra.api_url;
    let baseURL = agent.extra.api_url;
    let apiKey = agent.extra.api_key;
    let model = agent.extra.model;

    switch (baseURL) {
      case "groq":
        baseURL = "https://api.groq.com/openai/v1";
        apiKey ||= Deno.env.get("GROQ_API_KEY");
        model ||= "openai/gpt-oss-20b";
        break;
      case "openai":
        // undefined makes OpenAI use the default base URL and the api key from
        // the OPENAI_API_KEY environment variable.
        baseURL = undefined;
      /* falls through */
      default:
        // Strip a trailing /responses if present; the client appends it.
        baseURL = baseURL?.replace("/responses", "") || undefined;
        apiKey ||= undefined;
        model ||= "gpt-5-mini";
        provider = !!baseURL && baseURL !== "openai" ? "custom" : "openai";
    }

    const billable = !agent.extra.api_key;

    // Fetch cost pricing before the LLM call.
    const { data: costs } = await this.client
      .schema("billing")
      .from("costs")
      .select("pricing, quantity")
      .eq("provider", provider)
      .eq("product", model)
      .lte("effective_at", new Date().toISOString())
      .order("effective_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .throwOnError();

    if (billable) {
      if (!costs) {
        throw new Error(`No pricing found for ${provider}/${model}`);
      }

      await this.client
        .schema("billing")
        .rpc("check_limit", {
          _organization_id: organization.id,
          _product_id: "ai_credits",
          _amount: 0,
        })
        .throwOnError();
    }

    const openai = new OpenAI({
      baseURL,
      apiKey,
      timeout: 30000,
      maxRetries: 2,
      defaultHeaders: contextHeaders(this.context),
    });

    let response: ResponsesResponse;

    let retries = 0;
    const maxRetries = 3;
    let input = request.input;

    while (true) {
      try {
        response = await openai.responses.create({
          model,
          instructions: request.instructions,
          input,
          temperature: agent.extra.temperature ?? undefined,
          max_output_tokens: agent.extra.max_tokens ?? undefined,
          tools: request.tools.length ? request.tools : undefined,
          tool_choice: MULTI_MESSAGE_RESPONSE ? "required" : undefined,
          parallel_tool_calls: request.tools.length ? true : undefined,
          store: false,
        });

        break;
      } catch (error) {
        if (
          retries < maxRetries &&
          error instanceof Error &&
          "status" in error &&
          error.status === 400
        ) {
          log.warn(`Retrying with error context... ${error.message}`);

          input = [
            ...input,
            {
              role: "user", // Phantom message
              content: `Previous request failed with error: ${error.message}`,
            },
          ];

          retries++;
          continue;
        }

        throw error;
      }
    }

    // Record AI usage in the ledger.
    if (response.usage) {
      const cost = costs
        ? this.calculateCost(
          response.usage,
          costs.pricing as Record<string, number>,
          costs.quantity,
        )
        : 0;

      await this.client
        .schema("billing")
        .from("ledger")
        .insert({
          organization_id: organization.id,
          product_id: "ai_credits",
          type: "consumption",
          quantity: -cost,
          agent_id: agent.id,
          provider,
          model,
          billable,
          metadata: response.usage,
        })
        .throwOnError();
    }

    return { output: response.output };
  }

  private async processRespondCall(
    respondCall: FunctionCallItem,
  ): Promise<MessageInsert[]> {
    const { agent, conversation } = this.context;

    const args = JSON.parse(respondCall.arguments) as {
      messages: Array<
        | { type: "text"; text: string }
        | { type: "file"; uri: string; name?: string; text?: string }
      >;
    };

    if (!args.messages?.length) {
      log.info("Respond called with empty messages. No response to user.");
      return [];
    }

    const outgoing: MessageInsert[] = [];

    for (const msg of args.messages) {
      if (msg.type === "text") {
        outgoing.push({
          organization_id: conversation.organization_id,
          service: conversation.service,
          organization_address: conversation.organization_address,
          contact_address: conversation.contact_address,
          direction: "outgoing",
          agent_id: agent.id,
          content: {
            version: "1",
            type: "text",
            kind: "text",
            text: msg.text,
          },
        });
      } else if (msg.type === "file") {
        const file = await getFileMetadata(this.client, msg.uri);

        if (msg.name) {
          file.name = msg.name;
        }

        const mimePrefix = file.mime_type.split("/")[0];
        const kind = (
          ["audio", "image", "video"].includes(mimePrefix)
            ? mimePrefix
            : "document"
        ) as "audio" | "image" | "video" | "document";

        outgoing.push({
          organization_id: conversation.organization_id,
          service: conversation.service,
          organization_address: conversation.organization_address,
          contact_address: conversation.contact_address,
          direction: "outgoing",
          agent_id: agent.id,
          content: {
            version: "1",
            type: "file",
            kind,
            file,
            text: msg.text,
          },
        });
      }
    }

    return outgoing;
  }

  async processResponse(
    response: ResponsesResponseWrapper,
  ): Promise<ResponseContext> {
    const { agent, conversation } = this.context;

    const functionCalls = response.output.filter(
      (item): item is FunctionCallItem => item.type === "function_call",
    );

    if (functionCalls.length) {
      // The virtual respond tool call, if present.
      const respondCall = functionCalls.find(
        (fc) => fc.name === RESPOND_FUNCTION_NAME,
      );

      if (respondCall) {
        const messages = await this.processRespondCall(respondCall);
        return { messages };
      }

      // Regular tool calls. Share one task id so prepareRequest can group the
      // parallel calls together.
      const taskId = crypto.randomUUID();

      const messages = functionCalls.map((toolCall): MessageInsert => {
        let tool: ToolEventInfo & LocalToolInfo;
        const name = toolCall.name;
        const text = toolCall.arguments;

        if (name.includes(this.FUNCTION_NAME_SEPARATOR)) {
          const [label, _name] = name.split(this.FUNCTION_NAME_SEPARATOR);

          const toolInfo = this.tools.find(
            (t) => t.label === label && t.name === _name,
          );

          tool = {
            use_id: toolCall.call_id,
            event: "use",
            provider: "local",
            type: (toolInfo?.type || "mcp") as "mcp" | "sql" | "http",
            label,
            name: _name,
          };
        } else {
          const toolInfo = this.tools.find((t) => t.name === name);

          tool = {
            use_id: toolCall.call_id,
            event: "use",
            provider: "local",
            type: (toolInfo?.type as "function" | "custom") || "function",
            name,
          };
        }

        return {
          organization_id: conversation.organization_id,
          service: conversation.service,
          organization_address: conversation.organization_address,
          contact_address: conversation.contact_address,
          direction: "internal" as const,
          agent_id: agent.id,
          content: {
            version: "1" as const,
            task: { id: taskId },
            tool: tool!,
            type: "text" as const,
            kind: "text" as const,
            text,
          },
        };
      });

      return { messages };
    }

    // No tool calls — fall back to any plain text output items.
    const text = response.output
      .filter((item): item is OpenAI.Responses.ResponseOutputMessage =>
        item.type === "message"
      )
      .flatMap((item) =>
        item.content
          .filter((c): c is OpenAI.Responses.ResponseOutputText =>
            c.type === "output_text"
          )
          .map((c) => c.text)
      )
      .join("\n")
      .trim();

    if (text) {
      if (MULTI_MESSAGE_RESPONSE) {
        log.warn(
          "Unexpected text output with tool_choice: required. Falling back to text response.",
        );
      }

      return {
        messages: [
          {
            organization_id: conversation.organization_id,
            service: conversation.service,
            organization_address: conversation.organization_address,
            contact_address: conversation.contact_address,
            direction: "outgoing",
            agent_id: agent.id,
            content: {
              version: "1",
              type: "text",
              kind: "text",
              text,
            },
          },
        ],
      };
    }

    return { messages: [] };
  }
}
