import ky from "ky";
import { type Part } from "../../_shared/supabase.ts";
import type {
  AgentProtocolHandler,
  RequestContext,
  ResponseContext,
} from "./base.ts";
import type {
  SendTaskRequest,
  SendTaskResponse,
  Part as A2aPart,
  FileContent,
} from "../../_shared/a2a_types.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import {
  fetchMedia,
  uploadToStorage,
  createSignedUrl,
  downloadFromStorage,
  base64ToBlob,
} from "../../_shared/media.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "../../_shared/db_types.ts";

export class A2AHandler
  implements AgentProtocolHandler<SendTaskRequest, SendTaskResponse>
{
  private context: RequestContext;
  private client: SupabaseClient;

  constructor(context: RequestContext, client: SupabaseClient) {
    this.context = context;
    this.client = client;
  }

  private async toA2a(part: Part): Promise<A2aPart[]> {
    switch (part.type) {
      case "text": {
        return [
          {
            type: "text",
            text: part.text,
            metadata: {
              kind: part.kind,
            },
          },
        ];
      }
      case "data": {
        return [
          {
            type: "data",
            data: part.data as Record<string, unknown>,
            metadata: {
              kind: part.kind,
            },
          },
        ];
      }
      case "file": {
        const parts: A2aPart[] = [];

        let file: FileContent;

        const sizeLimit =
          this.context.agent.extra.send_inline_files_up_to_size_mb;

        if (
          part.file.size &&
          sizeLimit &&
          part.file.size <= sizeLimit * 1024 * 1024
        ) {
          const fileBlob = await downloadFromStorage(
            this.client,
            part.file.uri,
          );

          file = {
            bytes: encodeBase64(await fileBlob.arrayBuffer()),
            name: part.file.name,
            mimeType: part.file.mime_type,
          };
        } else {
          file = {
            uri: await createSignedUrl(this.client, part.file.uri),
            name: part.file.name,
            mimeType: part.file.mime_type,
          };
        }

        parts.push({
          type: "file",
          file,
          metadata: {
            kind: part.kind,
            size: part.file.size,
          },
        });

        if (part.text) {
          parts.push({
            type: "text",
            text: part.text,
            metadata: { kind: "caption" },
          });
        }

        // Handle artifacts recursively
        if (part.artifacts) {
          for (const artifact of part.artifacts) {
            const artifactParts = await this.toA2a(artifact);
            parts.push(...artifactParts);
          }
        }

        return parts;
      }
    }
  }

  private async fromA2a(part: A2aPart): Promise<Part> {
    const org = this.context.organization;

    switch (part.type) {
      case "text": {
        return {
          type: "text",
          kind: "text",
          text: part.text,
        };
      }
      case "data": {
        return {
          type: "data",
          kind: "data",
          data: part.data as Json,
        };
      }
      case "file": {
        const mime_type = part.file.mimeType || "application/octet-stream";
        let uri: string;
        let fileSize: number;

        if (part.file.bytes) {
          const file = base64ToBlob(part.file.bytes, mime_type);
          fileSize = file.size;
          uri = await uploadToStorage(this.client, org.id, file);
        } else if (part.file.uri) {
          const file = await fetchMedia(part.file.uri);
          fileSize = file.size;
          uri = await uploadToStorage(this.client, org.id, file);
        }

        let kind = "document";

        const firstPart = mime_type.split("/")[0].toLowerCase();

        if (["image", "video", "audio"].includes(firstPart)) {
          kind = firstPart;
        }

        return {
          type: "file",
          kind: kind as "document" | "image" | "video" | "audio",
          file: {
            uri: uri!,
            mime_type,
            ...(part.file.name && { name: part.file.name }),
            size: fileSize!,
          },
        };
      }
    }
  }

  async prepareRequest(): Promise<SendTaskRequest> {
    // Contact (or even an agent) might have sent i.e. three messages in a row. Hence, we need to merge them.
    const { messages, agent } = this.context;

    const lastMessage = messages.at(-1);

    const lastPreviousTurnMessageIdx = messages.findLastIndex(
      (m) => m.agent_id !== lastMessage?.agent_id,
    );

    const currentTurnMessages = messages.slice(lastPreviousTurnMessageIdx + 1);

    // Multiple messages are merged into a single A2A message.
    const parts = (
      await Promise.all(
        currentTurnMessages.map(({ content }) => this.toA2a(content as Part)),
      )
    ).flat();

    const message = {
      role: (lastMessage?.agent_id === agent.id ? "agent" : "user") as
        | "agent"
        | "user",
      parts,
    };

    const lastAgentTask = messages.findLast((m) => m.agent_id === agent.id);

    const taskId =
      (lastAgentTask?.content.task?.status === "input-required" &&
        lastAgentTask.content.task.id) ||
      crypto.randomUUID();

    const sessionId =
      lastAgentTask?.content.task?.session_id || crypto.randomUUID();

    return {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tasks/send",
      params: {
        id: taskId,
        sessionId,
        message,
        metadata: this.context as unknown as Record<string, unknown>,
      },
    };
  }

  async sendRequest(request: SendTaskRequest): Promise<SendTaskResponse> {
    const { agent } = this.context;

    if (!agent.extra.api_url) {
      throw new Error("Agent URL is not set.");
    }

    const response = await ky(agent.extra.api_url, {
      method: "POST",
      headers: {
        ...(agent.extra.api_key && {
          Authorization: `Bearer ${agent.extra.api_key}`,
        }),
      },
      json: request,
    }).json<SendTaskResponse>();

    if (response.error) {
      throw new Error(response.error.message);
    }

    /**
     * Suggested error class names:
     * - For failed fetch, network issues, or client-server communication problems:
     *     - A2ACommunicationError
     *     - A2AClientError
     *     - A2ANetworkError
     *
     * - For successful communication but the response contains an error message:
     *     - A2AProtocolError
     *     - A2AServerError
     *     - A2AResponseError
     */

    return response;
  }

  async processResponse(response: SendTaskResponse): Promise<ResponseContext> {
    const { agent, conversation } = this.context;

    if (!response.result) {
      throw new Error("No result returned from agent.");
    }

    const responseStatus = response.result.status;

    if (!responseStatus?.message) {
      return { messages: [] };
    }

    const parts = await Promise.all(
      responseStatus.message.parts.map(this.fromA2a),
    );

    const outputMessagesV1 = parts.map((part: Part) => ({
      service: conversation.service,
      organization_address: conversation.organization_address,
      contact_address: conversation.contact_address,
      direction: "outgoing" as const,
      type: "outgoing" as const,
      agent_id: agent.id,
      message: {
        version: "1" as const,
        task: {
          id: response.result!.id,
          status: responseStatus.state,
          session_id: response.result!.sessionId,
        },
        ...part,
      },
    }));

    // TODO: artifacts
    // TODO: metadata (messages, conversations, contact, etc)

    return {
      // @ts-ignore TODO: data parts are not included in the type definitions
      // of outgoing messages (they are allowed in internal messages)
      messages: outputMessagesV1,
    };
  }
}
