import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import type {
  LocalToolInfo,
  MessageInsert,
  MessageRow,
  Part,
  ToolEventInfo,
  ToolInfo,
} from "../../_shared/supabase.ts";
import type {
  AgentProtocolHandler,
  RequestContext,
  ResponseContext,
} from "./base.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentTool } from "../index.ts";
import * as log from "../../_shared/logger.ts";
import { serializePartAsXML } from "./serializer.ts";

export interface ChatCompletionsRequest {
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
}

export interface ChatCompletionsResponse {
  finish_reason: ChatCompletion["choices"][number]["finish_reason"];
  message: ChatCompletionMessage;
  usage?: ChatCompletion["usage"];
}

export class ChatCompletionsHandler
  implements
    AgentProtocolHandler<ChatCompletionsRequest, ChatCompletionsResponse> {
  private tools: AgentTool[];
  private context: RequestContext;
  private client: SupabaseClient;
  private FUNCTION_NAME_SEPARATOR = "__";

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
   * An assistant message with 'tool_calls' must be followed by
   * tool messages responding to each 'tool_call_id'.
   *
   * The problem is that the tool messages order is not guaranteed.
   */
  private sortToolMessages(messages: MessageRow[]): MessageRow[] {
    const taskMap = new Map<
      string,
      {
        uses: MessageRow[];
        results: MessageRow[];
      }
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
          task = {
            uses: [],
            results: [],
          };

          taskMap.set(taskId, task);
        }

        if (row.content.tool.event === "use") {
          if (!task.uses.length) {
            // Use the first appeareance of a tool use within a task as a placeholder.
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

  private removeOtherAgentsToolMessages(messages: MessageRow[]): MessageRow[] {
    return messages.filter((message) => {
      if (message.direction === "internal" && message.content.tool) {
        return message.agent_id === this.context.agent.id;
      }

      return true;
    });
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
   * Expects tool messages to be sorted.
   */
  private mergeToolUseMessages(
    messages: MessageRow[],
  ): ChatCompletionMessageParam[] {
    const messageParams: ChatCompletionMessageParam[] = [];

    for (const row of messages) {
      const lastParam = messageParams.at(-1);

      const param = this.toChatCompletion(
        row.agent_id,
        row.content as Part & ToolInfo,
      );

      if (
        lastParam &&
        "tool_calls" in lastParam &&
        Array.isArray(lastParam.tool_calls) &&
        "tool_calls" in param &&
        Array.isArray(param.tool_calls)
      ) {
        lastParam.tool_calls.push(...param.tool_calls);

        continue;
      }

      messageParams.push(param);
    }

    return messageParams;
  }

  /**
   * Chat Completions does not keep the message history of the conversation.
   * That's why we do not send files but some text representation of them.
   * It would be costly to send the same files over and over again during the conversation.
   */
  private toChatCompletion(
    agentId: string | null | undefined,
    part: Part & ToolInfo,
  ): ChatCompletionMessageParam {
    const role = agentId === this.context.agent.id ? "assistant" : "user";

    if (part.tool?.provider === "local") {
      if (part.tool.event === "use") {
        const name = ["label" in part.tool && part.tool.label, part.tool.name]
          .filter(Boolean)
          .join(this.FUNCTION_NAME_SEPARATOR);

        if (part.type === "data") {
          const toolCall: ChatCompletionMessageToolCall = {
            id: part.tool.use_id,
            function: {
              name,
              arguments: JSON.stringify(part.data),
            },
            type: "function",
          };

          const message: ChatCompletionAssistantMessageParam = {
            role: "assistant",
            tool_calls: [toolCall],
          };

          return message;
        }

        if (part.type === "text") {
          const toolCall: ChatCompletionMessageToolCall = {
            id: part.tool.use_id,
            custom: {
              name,
              input: part.text,
            },
            type: "custom",
          };

          const message: ChatCompletionAssistantMessageParam = {
            role: "assistant",
            tool_calls: [toolCall],
          };

          return message;
        }
      }

      if (part.tool.event === "result") {
        if (part.type === "data") {
          const message: ChatCompletionToolMessageParam = {
            role: "tool",
            content: JSON.stringify(part.data),
            tool_call_id: part.tool.use_id,
          };

          return message;
        }

        if (part.type === "text") {
          const message: ChatCompletionToolMessageParam = {
            role: "tool",
            content: part.text,
            tool_call_id: part.tool.use_id,
          };

          return message;
        }
      }
    }

    return {
      role,
      content: serializePartAsXML(part),
    };
  }

  async prepareRequest(): Promise<ChatCompletionsRequest> {
    let { messages, agent } = this.context;

    const max = agent.extra.max_messages;

    if (max && messages.length > max) {
      // TODO: Watch out for tools/tasks requests and responses, it would make no sense to cut the message
      // history after the request and before the response.
      messages = messages.slice(-max);
    }

    // TODO: Commented out, waiting for multi-agent support.
    //messages = this.removeOtherAgentsToolMessages(messages);
    // TODO: remove tool messages of missing tool definitions (this.tools)?
    // They tend to confuse the model with unexpected tool calls.
    messages = this.removeUnpairedToolMessages(messages);
    messages = this.sortToolMessages(messages);

    const chatCompletionMessages = this.mergeToolUseMessages(messages);

    if (agent.extra.instructions) {
      // TODO: dynamic variables
      chatCompletionMessages.unshift({
        role: "system",
        content: agent.extra.instructions,
      });
    }

    const chatCompletionTools = this.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: ["label" in tool && tool.label, tool.name]
          .filter(Boolean)
          .join(this.FUNCTION_NAME_SEPARATOR),
        description: tool.description,
        parameters: tool.inputSchema,
        /**
         * NOTE:
         * - For each object in the parameters schema, set `additionalProperties: false`.
         * - All fields in `properties` must be included in `required`.
         * - To denote optional fields, add `null` as a type option in the schema.
         * - Anthropic does not support (ignores) `strict` mode.
         */
        //strict: true,
      },
    }));

    return {
      messages: chatCompletionMessages,
      tools: chatCompletionTools,
    };
  }

  async sendRequest(
    request: ChatCompletionsRequest,
  ): Promise<ChatCompletionsResponse> {
    const { agent } = this.context;

    let baseURL = agent.extra.api_url;
    let apiKey = agent.extra.api_key;
    let model = agent.extra.model;

    switch (baseURL) {
      case "groq":
        baseURL = "https://api.groq.com/openai/v1";
        apiKey ||= Deno.env.get("GROQ_API_KEY");
        model ||= "openai/gpt-oss-20b";
        break;
      case "anthropic":
        baseURL = "https://api.anthropic.com/v1";
        apiKey ||= Deno.env.get("ANTHROPIC_API_KEY");
        model ||= "claude-sonnet-4-20250514";
        break;
      case "google":
        baseURL = "https://generativelanguage.googleapis.com/v1beta/openai";
        apiKey ||= Deno.env.get("GEMINI_API_KEY");
        model ||= "gemini-2.5-flash";
        break;
      default:
        // undefined makes OpenAI use the default base URL
        // and api key from the OPENAI_API_KEY environment variable.
        baseURL ||= undefined;
        apiKey ||= undefined;
        model ||= "gpt-5-mini";
    }
    // Note: for Bedrock, the base URL is https://${bedrock-runtime-endpoint}/openai/v1

    const openai = new OpenAI({
      baseURL,
      apiKey,
      timeout: 30000, // 30 seconds
      maxRetries: 2,
    });

    const response = await openai.chat.completions.create({
      model,
      temperature: agent.extra.temperature ?? undefined,
      max_completion_tokens: agent.extra.max_tokens ?? undefined,
      messages: request.messages,
      // TOOLS
      tools: request.tools,
      parallel_tool_calls: true,
      // THINKING
      // ts-expect-error
      //thinking: { type: "enabled", budget_tokens: 2000 },
      //reasoning_effort: agent.extra.thinking || "low",
    });

    return {
      finish_reason: response.choices[0].finish_reason,
      message: response.choices[0].message,
      usage: response.usage,
    };
  }

  async processResponse(
    response: ChatCompletionsResponse,
  ): Promise<ResponseContext> {
    const { finish_reason, message } = response;
    const { agent, conversation } = this.context;

    if (finish_reason === "tool_calls" && message.tool_calls?.length) {
      const taskId = crypto.randomUUID();

      const messages = message.tool_calls.map((toolCall): MessageInsert => {
        let tool: ToolEventInfo & LocalToolInfo;
        let name: string;
        let text: string;

        if (toolCall.type === "custom") {
          name = toolCall.custom.name;
          text = toolCall.custom.input;
        } else {
          name = toolCall.function.name;
          text = toolCall.function.arguments;
        }

        if (name.includes(this.FUNCTION_NAME_SEPARATOR)) {
          const [label, _name] = name.split(this.FUNCTION_NAME_SEPARATOR);

          const toolInfo = this.tools.find(
            (t) => t.label === label && t.name === _name,
          );

          tool = {
            use_id: toolCall.id,
            event: "use",
            provider: "local",
            // Default: Pick any type. Function name check is performed elsewhere.
            type: (toolInfo?.type || "mcp") as "mcp" | "sql" | "http",
            label,
            name: _name,
          };
        } else {
          const toolInfo = this.tools.find((t) => t.name === name);

          tool = {
            use_id: toolCall.id,
            event: "use",
            provider: "local",
            type: (toolInfo?.type as "function" | "custom") || "function",
            name,
          };
        }

        return {
          service: conversation.service,
          organization_address: conversation.organization_address,
          contact_address: conversation.contact_address,
          direction: "internal" as const,
          agent_id: agent.id,
          content: {
            version: "1" as const,
            task: {
              // This id will be used to merge all the tool calls together
              // in one single message during prepareRequest().
              id: taskId,
            },
            tool: tool!,
            type: "text" as const,
            kind: "text" as const,
            // Note: Function arguments are parsed during tool handling.
            // TODO: custom tool input is text (do not parse).
            text,
          },
        };
      });

      return {
        messages,
      };
    }

    // TODO: finish reasons: length, content filter

    if (finish_reason === "stop" && message.content) {
      return {
        messages: [
          {
            service: conversation.service,
            organization_address: conversation.organization_address,
            contact_address: conversation.contact_address,
            direction: "outgoing",
            agent_id: agent.id,
            content: {
              version: "1",
              type: "text",
              kind: "text",
              text: message.content,
            },
          },
        ],
      };
    }

    return {
      messages: [],
    };
  }
}
