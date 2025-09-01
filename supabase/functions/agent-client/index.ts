import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as log from "../_shared/logger.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type WebhookPayload,
  type MessageRow,
  type MessageInsert,
  type MessageRowV1,
  type AgentRow,
  type TextPart,
  createClient,
  type LocalMCPToolConfig,
  type Part,
  type ToolInfo,
} from "../_shared/supabase.ts";
import { toV1, fromV1 } from "./messages-v0.ts";
import { ProtocolFactory } from "./protocols/index.ts";
import { annotateMessage } from "./annotator.ts";
import { callTool, initMCP, type MCPServer } from "./tools/mcp.ts";
import { Toolbox } from "./tools/index.ts";
import { z } from "zod";
import Ajv2020 from "https://esm.sh/ajv@^8.17.1/dist/2020";
import type { Json } from "../_shared/db_types.ts";
import type { AgentRowWithExtra, ResponseContext } from "./protocols/base.ts";

export type AgentTool = {
  provider: "local";
  type: "function" | "custom" | "mcp" | "http" | "sql";
  label?: string;
  name: string;
  description?: string;
  inputSchema: z.core.JSONSchema.JSONSchema;
  outputSchema?: z.core.JSONSchema.JSONSchema;
  implementation?: any;
  config?: any;
};

const PAUSED_CONV_WINDOW = 12 * 60 * 60 * 1000; // 12 hours
const MESSAGES_TIME_LIMIT = 3 * 24 * 60 * 60 * 1000; // 3 days
const MESSAGES_QUANTITY_LIMIT = 50;
const RESPONSE_DELAY = 3 * 1000; // 3 seconds
const ANNOTATION_TIMEOUT = 10 * 1000; // 10 seconds

Deno.serve(async (req) => {
  const client = createClient(req);

  const incoming = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  // RETRIEVE CONVERSATION + ORGANIZATION + CONTACT + AGENTS (via organization, one-hop join)

  const { data: conv, error: convError } = await client
    .from("conversations")
    .select(`*, organizations (*, agents (*)), contacts (*)`)
    .eq("organization_address", incoming.organization_address)
    .eq("contact_address", incoming.contact_address)
    .single();

  if (convError) {
    throw convError;
  }

  const { organizations: org, contacts: contact, ...conversation } = conv;

  if (!conv.extra) {
    conv.extra = {};
  }

  if (!org) {
    throw new Error(`Organization for conversation ${conv.name} not found.`);
  }

  if (!org.extra) {
    org.extra = {};
  }

  const { agents, ...organization } = org;

  // CHECK IF CONTACT IS ALLOWED

  if (
    org.extra.respond_to_allowed_contacts_only &&
    (!contact || !contact.extra?.allowed)
  ) {
    log.info(
      `Conversation ${conv.name} does not correspond to an authorized contact. Skipping response.`
    );
    return new Response("ok", { headers: corsHeaders });
  }

  // ANNOTATE INCOMING MESSAGE

  let annotationDuration = 0;

  if (org.extra.annotations) {
    const annotationStart = new Date();

    // TODO: Timeout and continue?
    await annotateMessage(incoming, org.extra.annotations, client);

    annotationDuration = +new Date() - +annotationStart;
  }

  // CHECK IF CONVERSATION IS PAUSED

  if (
    conv.extra.paused &&
    +new Date(conv.extra.paused) > +new Date() - PAUSED_CONV_WINDOW
  ) {
    log.info(`Conversation with ${conv.name} is paused. Skipping response.`);
    return new Response("ok", { headers: corsHeaders });
  }

  // CHECK IF THERE ARE ACTIVE AI AGENTS

  const aiAgents = agents.filter(
    (agent) => agent.ai && agent.extra && agent.extra.mode !== "inactive"
  );

  if (!aiAgents.length && !org.extra.welcome_message) {
    log.info(
      `No active AI agents found for conversation ${conv.name}. Skipping response.`
    );
    return new Response("ok", { headers: corsHeaders });
  }

  // WAIT FOR A NEWER MESSAGE

  const delay = Math.round(
    (org.extra.response_delay_seconds !== undefined
      ? org.extra.response_delay_seconds * 1000
      : RESPONSE_DELAY) - annotationDuration
  );

  if (delay > 0) {
    log.info(`Waiting ${delay}ms before processing the message...`);

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // RETRIEVE MESSAGES

  const { data: messages_v0, error: messagesError } = await client
    .from("messages")
    .select()
    .eq("organization_address", conv.organization_address)
    .gt(
      "timestamp",
      new Date(
        +new Date(incoming.timestamp) - MESSAGES_TIME_LIMIT
      ).toISOString()
    ) // Time constraint for the conversation.
    .eq("contact_address", conv.contact_address)
    .order("timestamp", { ascending: false })
    .limit(MESSAGES_QUANTITY_LIMIT); // Size constraint for the conversation.

  if (messagesError) {
    throw messagesError;
  }

  messages_v0.reverse();

  // CHECK IF THERE IS A NEWER MESSAGE

  /** TODO: timestamp vs created_at
   *
   *  - timestamp is given by the service (i.e. WhatsApp) servers.
   *  - created_at is the timestamp of the message insertion into the database.
   *
   *  created_at let us react to the latest message.
   *
   *  When a batch of disordered messages (timestamp) is close in time, it works well.
   *  But when messages are far in time, the result is not as desired,
   *  because the agent will respond to an outdated message.
   */

  function isNewerMessage(incoming: MessageRow, messages: MessageRow[]) {
    const incomingCreatedAt = new Date(incoming.created_at);

    const sortedMessages = messages
      .filter((m) => new Date(m.created_at) >= incomingCreatedAt)
      .sort((a, b) => {
        const dateA = +new Date(a.created_at);
        const dateB = +new Date(b.created_at);

        if (dateA !== dateB) {
          return dateB - dateA; // descending by created_at
        }

        // If created_at is the same, order by id descending
        if (a.id < b.id) return 1;
        if (a.id > b.id) return -1;
        return 0;
      });

    const newestMessage = sortedMessages[0];

    if (newestMessage && newestMessage.id !== incoming.id) {
      return newestMessage;
    }

    return null;
  }

  const newestMessage = isNewerMessage(incoming, messages_v0);

  if (newestMessage) {
    // Then the newest message is not the incoming one that triggered this edge function.
    log.info(
      `Newer message with id ${newestMessage.id} for conversation ${conv.name} found. Skipping response.`
    );

    return new Response("ok", { headers: corsHeaders });
  }

  // CHECK FOR PENDING ANNOTATIONS

  const pendingAnnotations = messages_v0.filter(
    (m) =>
      m.status.annotating &&
      !m.status.annotated &&
      +new Date(m.status.annotating) > +new Date() - ANNOTATION_TIMEOUT
  );

  if (pendingAnnotations.length) {
    // WAIT FOR THE ANNOTATIONS TO COMPLETE

    // Find the most recent annotating timestamp among pending annotations
    const mostRecentAnnotating = pendingAnnotations.reduce((mostRecent, m) => {
      return new Date(m.status.annotating!) >
        new Date(mostRecent.status.annotating!)
        ? m
        : mostRecent;
    }, pendingAnnotations[0]);

    const annotationDuration =
      +Date.now() - +new Date(mostRecentAnnotating.status.annotating!);

    // TODO: Polling instead of waiting?
    const delay = Math.round(ANNOTATION_TIMEOUT - annotationDuration);

    if (delay > 0) {
      log.info(`Waiting ${delay}ms for pending annotations to complete...`);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // RETRIEVE ANNOTATIONS

    const { data: annotated_messages_v0, error: messagesError } = await client
      .from("messages")
      .select()
      .eq("organization_address", conv.organization_address)
      .gt(
        "timestamp",
        new Date(
          +new Date(incoming.timestamp) - MESSAGES_TIME_LIMIT
        ).toISOString()
      ) // Time constraint for the conversation.
      .eq("contact_address", conv.contact_address)
      .order("timestamp")
      .limit(MESSAGES_QUANTITY_LIMIT); // Size constraint for the conversation.

    if (messagesError) {
      throw messagesError;
    }

    const newestMessage = isNewerMessage(incoming, annotated_messages_v0);

    if (newestMessage) {
      // Then the newest message is not the incoming one that triggered this edge function.
      log.info(
        `Newer message with id ${newestMessage.id} for conversation ${conv.name} found. Skipping response.`
      );

      return new Response("ok", { headers: corsHeaders });
    }

    const timedoutAnnotations = annotated_messages_v0.filter(
      (m) => m.status.annotating && !m.status.annotated
    );

    if (timedoutAnnotations.length) {
      log.warn(
        `${timedoutAnnotations.length} timed out annotations found for conversation ${conv.name}. Proceeding with the response.`
      );
    }

    messages_v0.length = 0;
    messages_v0.push(...annotated_messages_v0);
  }

  const messages = messages_v0.map(toV1).filter(Boolean) as MessageRowV1[];

  // SESSION RESTART if /new is found — USEFUL FOR WHATSAPP TESTING

  const firstMessageIndex = messages.findLastIndex(
    ({ direction, message }) =>
      direction === "incoming" &&
      message.type === "text" &&
      message.text.startsWith("/new")
  );

  if (firstMessageIndex > -1) {
    const firstMessage = messages[firstMessageIndex].message as TextPart;

    firstMessage.text = firstMessage.text.replace("/new", "");

    messages.splice(0, firstMessageIndex);

    // Also, reset the conversation memory
    if (conv.extra.memory && Object.keys(conv.extra.memory).length) {
      conv.extra.memory = {};

      const { error } = await client
        .from("conversations")
        .update({ extra: conv.extra })
        .eq("organization_address", conv.organization_address)
        .eq("contact_address", conv.contact_address);

      if (error) {
        throw error;
      }
    }
  }

  log.info("Contact request", messages.at(-1)?.message);

  // WELCOME MESSAGE

  if (
    org.extra.welcome_message &&
    messages.every((m) => m.direction !== "outgoing")
  ) {
    const outgoing: MessageInsert = {
      service: conv.service,
      organization_address: conv.organization_address,
      contact_address: conv.contact_address,
      direction: "outgoing",
      type: "outgoing", // TODO: Deprecate
      message: {
        type: "text",
        content: org.extra.welcome_message.replaceAll("**", "*"), // TODO: Deprecate
      },
    };

    log.info("Welcome message", outgoing.message.content);

    const { error: insertError } = await client
      .from("messages")
      .insert(outgoing);

    if (insertError) throw { insertError };

    return new Response("ok", { headers: corsHeaders });
  }

  // AGENT SELECTION

  if (!aiAgents.length) {
    log.info(
      `No active AI agents found for conversation ${conv.name}. Skipping response.`
    );
    return new Response("ok", { headers: corsHeaders });
  }

  let agent: AgentRow | null | undefined;

  // 1. Find the agent_id of the last message from an AI agent

  const lastAgentId = messages.findLast((m) => m.agent_id)?.agent_id;

  agent = aiAgents.find((a) => a.id === lastAgentId);

  // 2. Fallback to the contact's group default agent

  const groupAgentMap = org.extra.default_agent_id_by_contact_group;

  if (!agent && groupAgentMap) {
    const defaultAgentId =
      groupAgentMap[conv.contacts?.extra?.group || "undefined"];

    agent = aiAgents.find((a) => a.id === defaultAgentId);
  }

  // 3. Fallback to any agent

  if (!agent) {
    agent = aiAgents[0];
  }

  // TYPING INDICATOR

  const indicateTyping = async (unread?: boolean) => {
    const { error: typingIndicatorError } = await client
      .from("messages")
      .update({
        status: {
          ...(unread && { read: new Date().toISOString() }),
          typing: new Date().toISOString(),
        },
      })
      .eq("id", incoming.id);

    if (typingIndicatorError) {
      log.warn(
        "Failed to update incoming message typing indicator status.",
        typingIndicatorError
      );
    }
  };

  indicateTyping(true);

  // The typing indicator will be dismissed once you respond,
  // or after 25 seconds. Hence, keep it alive. Some extra delay
  // is added to avoid race conditions with the response.
  const typingInterval = setInterval(indicateTyping, 30000);

  // CONTEXT

  if (!agent.extra) {
    agent.extra = {};
  }

  const context = {
    organization,
    conversation,
    messages,
    contact,
    agent: agent as AgentRowWithExtra,
  };

  // REQUEST LOOP

  /**
   * agent.extra.tools
   *   - function
   *   - mcp
   *   - gemini: google_search, code_execution, url_context
   *   - openai: mcp, web_search_preview, file_search, image_generation, code_interpreter, computer_use_preview
   *   - anthropic: mcp*, bash, code_execution, computer, str_replace_based_edit_tool, web_search
   *
   * context.tools -> tools + expanded mcp tools
   */

  const mcpServers: Map<string, MCPServer> = new Map();

  let iteration = 0;
  const max_iterations = 5;
  let shouldContinue = true;

  // Basic ReAct algorithm: stop if no tool uses are found.
  while (shouldContinue) {
    iteration++;

    let response: ResponseContext = {};

    try {
      if (iteration > max_iterations) {
        throw new Error("Max LLM iterations reached!");
      }

      // MCP server initialization

      const mcpServersToInit =
        agent.extra.tools?.filter(
          (tool) =>
            tool.provider === "local" &&
            tool.type === "mcp" &&
            !mcpServers.has(tool.label)
        ) || [];

      const mcpServersAux = await Promise.all(
        mcpServersToInit.map((tool) => initMCP(tool as LocalMCPToolConfig))
      );

      mcpServersAux.forEach((mcp) => {
        mcpServers.set(mcp.label, mcp);
      });

      // Iteration tools

      /**
       * Tools to be passed the agent are gruped in two main categories:
       * 1. Local tools
       * 2. External tools
       *
       * Local tools need to be passed to the agent with their input schema.
       * External tools do not require more than their tool config as it comes.
       *
       * We have the following tool types:
       * - `ToolInfo` to tag tool use/result messages with basic tool info (specially `label` and `name`).
       * - `ToolConfig` for agents to declare their tools (`label`, `name` might be unknown for MCP tools and others).
       * - `ToolDefinition`, which as its name suggests, defines the tool (`label` is unknown at definition, only `name`).
       * - `AgentTool`, the combination of config and definition, to be passed to the agent.
       */
      const tools: AgentTool[] = [];

      for (const toolConfig of agent.extra.tools || []) {
        if (toolConfig.provider !== "local") {
          continue;
        }

        // TODO: allowed tools

        switch (toolConfig.type) {
          case "function": {
            const unlabeledTool = Toolbox.function.find(
              (t) => t.name === toolConfig.name
            );

            if (!unlabeledTool) {
              throw new Error(`Tool ${toolConfig.name} not found.`);
            }

            tools.push(unlabeledTool);

            break;
          }
          case "mcp": {
            const unlabeledTools = mcpServers.get(toolConfig.label)!.tools;

            for (const unlabeledTool of unlabeledTools) {
              const labeledTool = {
                provider: toolConfig.provider,
                type: toolConfig.type,
                label: toolConfig.label,
                name: unlabeledTool.name,
                description: unlabeledTool.description,
                inputSchema:
                  unlabeledTool.inputSchema as z.core.JSONSchema.JSONSchema,
                outputSchema: unlabeledTool.outputSchema as
                  | z.core.JSONSchema.JSONSchema
                  | undefined,
                config: toolConfig.config,
              };

              tools.push(labeledTool);
            }

            break;
          }
          case "http":
          case "sql": {
            const unlabeledTools = Toolbox[toolConfig.type];

            for (const unlabeledTool of unlabeledTools) {
              const labeledTool = {
                ...unlabeledTool,
                label: toolConfig.label,
                config: toolConfig.config,
              };

              tools.push(labeledTool);
            }

            break;
          }
        }
      }

      const handler = ProtocolFactory.getHandler(context, client, tools);

      const agentRequest = await handler.prepareRequest();

      const agentResponse = await handler.sendRequest(agentRequest);

      response = await handler.processResponse(agentResponse);

      if (!response.messages?.length) {
        response.messages = [];
      }

      const toolUses =
        response.messages.filter(
          (m) =>
            m.direction === "internal" &&
            m.message.type === "text" &&
            m.message.tool &&
            m.message.tool.provider === "local"
        ) || [];

      for (const row of toolUses) {
        // Only needed to please the TypeScript compiler
        if (
          row.direction !== "internal" ||
          row.message.type !== "text" ||
          !row.message.tool ||
          row.message.tool.provider !== "local"
        ) {
          continue;
        }

        /**
         * # Tool uses and results within parallel tool use
         *
         * Chat Completions API produces a single message with several tool choices.
         * It expects tool results as single messages.
         *
         * On the other hand, Responses API and Messages API also produce a single with several tool uses.
         * But on the contrary, they expect tool results as a single message.
         *
         * Here, the adopted policy is to adhere to the WhatsApp API, this is one message per part.
         * A tool use/result is considered a part.
         */
        const toolInfo = row.message.tool;

        const agentTool = tools.find(
          (t) =>
            t.provider === toolInfo.provider &&
            t.type === toolInfo.type &&
            ("label" in toolInfo ? t.label === toolInfo.label : true) &&
            t.name === toolInfo.name
        );

        if (!agentTool) {
          log.warn("Tool not found", toolInfo);
          continue;
        }

        let input: string | Json = row.message.text;

        if (agentTool.inputSchema) {
          const ajv = new Ajv2020();
          const schema = agentTool.inputSchema;

          // TODO: This might fail.
          input = JSON.parse(input);

          // When JSON parsing is done, the message is converted to a data part.
          row.message = {
            version: "1",
            task: row.message.task,
            tool: toolInfo,
            type: "data",
            kind: "data",
            data: input,
          };

          const valid = ajv.validate(schema, input);

          if (!valid) {
            log.warn("Invalid tool data", ajv.errors);
          }
        }

        let parts: (Part & ToolInfo)[] = [];

        switch (toolInfo.type) {
          case "custom":
          case "function": {
            const result = await agentTool.implementation(input);

            parts = [
              {
                tool: {
                  ...toolInfo,
                  event: "result" as const,
                },
                type: "data",
                kind: "data",
                data: result,
              },
            ];

            break;
          }
          case "mcp": {
            const mcp = mcpServers.get(agentTool.label!);

            if (!mcp) {
              continue;
            }

            parts = await callTool(mcp, row.message, client, conv);

            break;
          }
          case "http":
          case "sql": {
            const result = await agentTool.implementation(
              input,
              agentTool.config,
              context
            );

            parts = [
              {
                tool: {
                  ...toolInfo,
                  event: "result" as const,
                },
                type: "data",
                kind: "data",
                data: result,
              },
            ];

            break;
          }
        }

        // TODO: Mutating the response object is not the most recommended way to do this
        // but it will be improved soon.
        const taskId = row.message.task?.id || crypto.randomUUID();

        response.messages.push(
          ...parts.map((part) => ({
            service: conv.service,
            organization_address: conv.organization_address,
            contact_address: conv.contact_address,
            direction: "internal" as const,
            type: "function_response" as const,
            agent_id: agent.id,
            message: {
              version: "1" as const,
              task: { id: taskId },
              ...part,
            },
          }))
        );
      }

      if (!toolUses.length) {
        shouldContinue = false;
      }
    } catch (error) {
      shouldContinue = false;

      log.error("Error in agent client", error as Error);

      response.messages = [
        // @ts-expect-error
        {
          service: conv.service,
          organization_address: conv.organization_address,
          contact_address: conv.contact_address,
          direction: org.extra.error_messages_direction || "internal",
          type: org.extra.error_messages_direction || "internal",
          agent_id: agent.id,
          message: {
            version: "1" as const,
            type: "text",
            kind: "text",
            text: (error as Error).toString(),
          },
        },
      ];
    }

    clearInterval(typingInterval);

    // STORE MESSAGES

    if (response.messages?.length) {
      log.info("Agent response", response.messages.at(-1)?.message);

      const output_messages = response.messages.map((message, index) => ({
        ...message,
        // Make sure the messages have the correct organization_address and contact_address
        organization_address: conv.organization_address,
        contact_address: conv.contact_address,
        // Disambiguate by milliseconds to ensure the insertion order.
        timestamp: new Date(+new Date() + index).toISOString(),
      }));

      const output_messages_v0 = output_messages
        .map(fromV1)
        .filter(Boolean) as MessageRow[];

      const { data: messages_v0, error: messagesError } = await client
        .from("messages")
        .insert(output_messages_v0)
        .select()
        .order("timestamp");

      if (messagesError) {
        throw messagesError;
      }

      context.messages = [
        ...context.messages,
        ...(messages_v0.map(toV1).filter(Boolean) as MessageRowV1[]),
      ];
    }
  }

  // STORE RESPONSE

  /*
  if (response?.conversation) {
    const { error } = await client
      .from("conversations")
      .update({
        extra: response.conversation.extra,
      })
      .eq("organization_address", conv.organization_address)
      .eq("contact_address", conv.contact_address);

    if (error) {
      log.error("Failed to update conversation extra field.", error);
    }
  }

  if (contact && response?.contact) {
    const { error } = await client
      .from("contacts")
      .update({
        extra: response.contact.extra,
      })
      .eq("id", contact.id);

    if (error) {
      log.error("Failed to update contact extra field.", error);
    }
  }
  */

  return new Response(JSON.stringify(messages), {
    headers: { "Content-Type": "application/json" },
  });
});

/** TODO
 * - Supabase schema
 *   - deployment
 * - README
 * - Mejores errores
 *   https://modelcontextprotocol.io/specification/2025-03-26/server/tools#error-handling
 */
