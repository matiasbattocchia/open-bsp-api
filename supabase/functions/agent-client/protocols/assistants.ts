import OpenAI from "openai";
import type { Part, ToolInfo } from "../../_shared/supabase.ts";
import type {
  AgentProtocolHandler,
  RequestContext,
  ResponseContext,
} from "./base.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSignedUrl,
  fetchMedia,
  uploadToStorage,
} from "../../_shared/media.ts";
import * as log from "../../_shared/logger.ts";
import { serializePartAsXML } from "./serializer.ts";

export interface AssistantsRequest {
  thread_id?: string;
  messages: OpenAI.Beta.Threads.MessageCreateParams[];
}

export interface AssistantsResponse {
  run_id: string;
  thread_id: string;
  messages: OpenAI.Beta.Threads.Message[];
  usage?: OpenAI.Beta.Threads.Run["usage"];
}

export class AssistantsHandler
  implements AgentProtocolHandler<AssistantsRequest, AssistantsResponse>
{
  private context: RequestContext;
  private client: SupabaseClient;
  private openai: OpenAI;

  constructor(context: RequestContext, client: SupabaseClient) {
    this.context = context;
    this.client = client;
    this.openai = new OpenAI({
      baseURL: context.agent.extra.api_url,
      apiKey: context.agent.extra.api_key,
      timeout: 10000, // 10 seconds
      maxRetries: 2,
    });
  }

  /**
   * Converts an internal Part into a textual representation that can be sent to
   * the Assistants API.  We re-use the same approach that ChatCompletions handler
   * employs so that media parts are flattened into tagged text blocks. At the
   * moment we only send text because the official guidance is *“do not send
   * other messages than text”*.
   */
  private async toAssistants(
    role: "user" | "assistant",
    part: Part & ToolInfo,
  ): Promise<OpenAI.Beta.Threads.MessageCreateParams> {
    switch (part.type) {
      case "text":
        return {
          role,
          content: part.text,
        };
      case "data":
        return {
          role,
          content:
            `<${part.kind}>\n` +
            JSON.stringify(part.data, null, 2) +
            `\n</${part.kind}>`,
        };
      case "file": {
        const content: OpenAI.Beta.Threads.MessageContentPartParam[] = [];

        const mimeSubtype = part.file.mime_type.split("/")[1].toLowerCase();

        const acceptedImageSubtypes = ["png", "jpeg", "jpg", "gif", "webp"];

        if (acceptedImageSubtypes.includes(mimeSubtype)) {
          content.push({
            type: "image_url",
            image_url: {
              url: await createSignedUrl(this.client, part.file.uri),
            },
          });
        }

        content.push({
          type: "text",
          text: serializePartAsXML(part),
        });

        return {
          role,
          content,
        };
      }
    }
  }

  private async fromAssistants(
    message: OpenAI.Beta.Threads.MessageContent,
  ): Promise<Part> {
    const org = this.context.organization;

    switch (message.type) {
      case "text": {
        return {
          type: "text",
          kind: "text",
          text: message.text.value,
        };
      }
      case "image_file": {
        throw new Error("Message content type image_file is not supported.");
      }
      case "image_url": {
        const file = await fetchMedia(message.image_url.url);
        const uri = await uploadToStorage(this.client, org.id, file);

        return {
          type: "file",
          kind: "image",
          file: {
            uri,
            mime_type: file.type,
            size: file.size,
          },
        };
      }
      case "refusal": {
        return {
          type: "text",
          kind: "text",
          text: message.refusal,
        };
      }
    }
  }

  async prepareRequest(): Promise<AssistantsRequest> {
    const { messages, agent } = this.context;

    const lastMessage = messages.at(-1);

    const lastPreviousTurnMessageIdx = messages.findLastIndex(
      (m) => m.agent_id !== lastMessage?.agent_id,
    );

    const currentTurnMessages = messages.slice(lastPreviousTurnMessageIdx + 1);

    const assistantsMessages = await Promise.all(
      currentTurnMessages.map(({ content, agent_id }) =>
        this.toAssistants(
          agent_id === agent.id ? "assistant" : "user",
          content as Part & ToolInfo,
        ),
      ),
    );

    const lastAgentTask = messages.findLast((m) => m.agent_id === agent.id);

    const thread_id = lastAgentTask?.content.task?.session_id;

    return {
      thread_id,
      messages: assistantsMessages,
    };
  }

  async sendRequest(request: AssistantsRequest): Promise<AssistantsResponse> {
    const { agent } = this.context;

    if (!request.thread_id) {
      const thread = await this.openai.beta.threads.create({
        messages: request.messages,
      });

      request.thread_id = thread.id;
    } else {
      // Threads can be locked by a run in progress.
      // We cancel it if it's not completed to process the latest messages.
      const runs = await this.openai.beta.threads.runs.list(request.thread_id, {
        limit: 1,
        order: "desc",
      });

      const run = runs.data[0];

      if (
        run?.status === "queued" ||
        run?.status === "in_progress" ||
        run?.status === "requires_action"
      ) {
        await this.openai.beta.threads.runs.cancel(run.id, {
          thread_id: request.thread_id,
        });
      }

      // Add messages to the thread.
      for (const message of request.messages) {
        await this.openai.beta.threads.messages.create(
          request.thread_id,
          message,
        );
      }
    }

    if (!agent.extra.assistant_id) {
      const assistant = await this.openai.beta.assistants.create({
        name: agent.name,
        description: agent.extra.description,
        instructions: agent.extra.instructions,
        model: agent.extra.model || "gpt-4.1-mini",
        temperature: agent.extra.temperature,
      });

      const { error } = await this.client
        .from("agents")
        .update({
          extra: {
            assistant_id: assistant.id,
          },
        })
        .eq("id", agent.id);

      if (error) {
        throw new Error(error.message);
      }

      agent.extra.assistant_id = assistant.id;
    }

    const run = await this.openai.beta.threads.runs.createAndPoll(
      request.thread_id,
      {
        assistant_id: agent.extra.assistant_id,
        // instructions: string; // override instructions
        tools: [], // TODO: Tools. By the time being, we don't support tools.
      },
    );

    if (run.status === "failed" || run.status === "expired") {
      throw new Error(`Run failed: ${run.status}`);
    } else if (run.status === "cancelled") {
      log.warn("Run cancelled.");
    }

    const runMessages = await this.openai.beta.threads.messages.list(
      run.thread_id,
      {
        run_id: run.id,
        order: "asc",
      },
    );

    return {
      run_id: run.id,
      thread_id: run.thread_id,
      messages: runMessages.data,
      usage: run.usage,
    };
  }

  async processResponse(
    response: AssistantsResponse,
  ): Promise<ResponseContext> {
    const { agent, conversation } = this.context;

    const parts = await Promise.all(
      response.messages
        .map((m) => m.content)
        .flat()
        .map(this.fromAssistants),
    );

    return {
      // @ts-ignore TODO: data parts are not included in the type definitions
      // of outgoing messages (they are allowed in internal messages)
      messages: parts.map((part) => ({
        service: conversation.service,
        organization_address: conversation.organization_address,
        contact_address: conversation.contact_address,
        direction: "outgoing",
        type: "outgoing",
        agent_id: agent.id,
        message: {
          version: "1",
          task: {
            id: response.run_id,
            status: "completed",
            session_id: response.thread_id,
          },
          ...part,
        },
      })),
    };
  }
}
