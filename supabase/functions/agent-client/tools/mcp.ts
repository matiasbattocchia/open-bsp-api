import type {
  LocalMCPToolConfig,
  Part,
  ToolInfo,
} from "../../_shared/supabase.ts";
import {
  fetchMedia,
  uploadToStorage,
  base64ToBlob,
} from "../../_shared/media.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
// Import map is bad at resolving entry points, so we need to use the full path.
import { Client } from "npm:@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ContentBlock,
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
  Tool,
} from "npm:@modelcontextprotocol/sdk/types.js";
import type { Json } from "../../_shared/db_types.ts";
import { RequestContext } from "../protocols/base.ts";

export type MCPServer = {
  label: string;
  client: Client;
  tools: Tool[];
};

export async function initMCP(tool: LocalMCPToolConfig): Promise<MCPServer> {
  const client = new Client({
    name: tool.label,
    version: "1.0",
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(tool.config.url),
    {
      ...(tool.config.headers && {
        requestInit: { headers: tool.config.headers },
      }),
    }
  );

  await client.connect(transport);

  const toolsResult: ListToolsResult = await client.listTools();

  return {
    label: tool.label,
    client,
    tools: toolsResult.tools,
  };
}

export async function fromMCP(
  part: ContentBlock,
  context: RequestContext,
  client: SupabaseClient
): Promise<Part> {
  const org = context.organization;

  switch (part.type) {
    case "text":
      return {
        type: "text",
        kind: "text",
        text: part.text,
      };
    case "image": {
      const file = base64ToBlob(part.data, part.mimeType);
      const uri = await uploadToStorage(client, org.id, file);

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
    case "audio": {
      const file = base64ToBlob(part.data, part.mimeType);
      const uri = await uploadToStorage(client, org.id, file);

      return {
        type: "file",
        kind: "audio",
        file: {
          uri,
          mime_type: file.type,
          size: file.size,
        },
      };
    }
    case "resource": {
      if (part.resource.type === "text") {
        const file = new Blob([part.resource.text as string], {
          type: part.resource.mimeType || "text/plain",
        });
        const uri = await uploadToStorage(client, org.id, file);

        return {
          type: "file",
          kind: "document",
          file: {
            uri,
            mime_type: file.type,
            size: file.size,
          },
        };
      }

      if (part.resource.type === "blob") {
        const file = base64ToBlob(
          part.resource.blob as string,
          part.resource.mimeType
        );
        const uri = await uploadToStorage(client, org.id, file);

        return {
          type: "file",
          kind: "document",
          file: {
            uri,
            mime_type: file.type,
            size: file.size,
          },
        };
      }
      throw new Error("Invalid resource type");
    }
    case "resource_link": {
      const file = await fetchMedia(part.uri);
      const uri = await uploadToStorage(client, org.id, file);

      return {
        type: "file",
        kind: "document",
        file: {
          uri,
          mime_type: file.type,
          size: file.size,
        },
      };
    }
  }
}

export async function callTool(
  mcp: MCPServer,
  part: Part & ToolInfo,
  context: RequestContext,
  client: SupabaseClient
): Promise<(Part & ToolInfo)[]> {
  if (
    !part.tool ||
    part.tool.provider !== "local" ||
    part.tool.type !== "mcp" ||
    part.type !== "data"
  ) {
    throw new Error("Invalid tool info or data");
  }

  const result = (await mcp.client.callTool({
    name: part.tool.name,
    arguments: part.data,
  } as CallToolRequest["params"])) as CallToolResult;

  const parts = result.structuredContent
    ? [
      {
        type: "data" as const,
        kind: "data" as const,
        data: result.structuredContent as Json,
      },
    ]
    : await Promise.all(
      result.content.map((part) => fromMCP(part, context, client))
    );

  return parts.map((outPart) => ({
    ...outPart,
    tool: {
      ...part.tool!,
      event: "result" as const,
      is_error: result.isError,
    },
  }));
}
