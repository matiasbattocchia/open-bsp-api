import { Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { streamSSE } from "jsr:@hono/hono/streaming";
import { createApiClient, type Database } from "../_shared/supabase.ts";
import * as log from "../_shared/logger.ts";
import { validateApiKey } from "./auth.ts";
import * as tools from "./tools.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

// Hono context variables set by auth middleware
type Variables = {
  orgId: string;
  supabase: SupabaseClient<Database>;
};

const app = new Hono<{ Variables: Variables }>();

app.use("*", cors());

// Auth middleware - validates API key and sets context variables
app.use("/mcp/*", async (c, next) => {
  try {
    const { orgId, token } = await validateApiKey(c.req.raw);
    c.set("orgId", orgId);
    c.set("supabase", createApiClient(token));
    await next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Authentication failed";
    return c.json({ error: message }, 401);
  }
});

// SSE Endpoint for MCP Connection
app.get("/mcp/sse", (c) => {
  return streamSSE(c, async (stream) => {
    const url = new URL(c.req.url);
    const messagesUrl = `${url.origin}/mcp/messages`;

    log.info(`MCP Client connected`, { endpoint: messagesUrl });

    await stream.writeSSE({
      event: "endpoint",
      data: messagesUrl,
    });

    // Keep connection open
    while (true) {
      await stream.sleep(10000);
    }
  });
});

// JSON-RPC Endpoint
app.post("/mcp/messages", async (c) => {
  const orgId = c.get("orgId");
  const supabase = c.get("supabase");

  const body = await c.req.json();
  const { id, method, params } = body;

  log.info(`MCP Request: ${method}`, params);

  // deno-lint-ignore no-explicit-any
  let result: any;

  try {
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "open-bsp-mcp",
            version: "1.0.0",
          },
        };
        break;

      case "notifications/initialized":
        // No response needed for notifications, but we return OK for the HTTP request
        return c.text("ok");

      case "ping":
        result = {};
        break;

      case "tools/list":
        result = {
          tools: [
            {
              name: "list_conversations",
              description: "Get recent active conversations with context (WhatsApp only).",
              inputSchema: {
                type: "object",
                properties: {
                  limit: { type: "number", description: "Max conversations (default: 10)" },
                },
              },
              outputSchema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Contact name" },
                    phone: { type: "string", description: "Contact phone number" },
                    account_phone: { type: "string", description: "Account phone (only if >1 account)" },
                    unread: { type: "number", description: "Unread message count" },
                    last_message: {
                      type: "object",
                      properties: {
                        direction: { type: "string", enum: ["incoming", "outgoing"] },
                        content: { type: "string" },
                        timestamp: { type: "string", format: "date-time" },
                        status: { type: "string" },
                        errors: { type: "array" },
                      },
                    },
                  },
                },
              },
            },
            {
              name: "get_conversation",
              description: "Get messages from a specific conversation.",
              inputSchema: {
                type: "object",
                properties: {
                  contact_phone: { type: "string", description: "Contact's phone number" },
                  account_phone: { type: "string", description: "Account phone (required if >1 account)" },
                  limit: { type: "number", description: "Max messages (default: 10)" },
                },
                required: ["contact_phone"],
              },
              outputSchema: {
                type: "object",
                properties: {
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        direction: { type: "string", enum: ["incoming", "outgoing"] },
                        content: { type: "string" },
                        timestamp: { type: "string", format: "date-time" },
                        status: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
            {
              name: "search_contacts",
              description: "Find contacts by name or phone number (one required).",
              inputSchema: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Name to search (case-insensitive, partial match)" },
                  number: { type: "string", description: "Phone number to search (partial match)" },
                },
              },
              outputSchema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    phone: { type: "string" },
                  },
                },
              },
            },
            {
              name: "list_accounts",
              description: "List connected WhatsApp accounts for this organization.",
              inputSchema: {
                type: "object",
                properties: {},
              },
              outputSchema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Account verified name" },
                    phone: { type: "string", description: "Account phone number" },
                  },
                },
              },
            },
            {
              name: "send_message",
              description: "Send a text message to a contact.",
              inputSchema: {
                type: "object",
                properties: {
                  contact_phone: { type: "string", description: "Contact's phone number" },
                  text: { type: "string", description: "Message text content" },
                  account_phone: { type: "string", description: "Account phone (required if >1 account)" },
                },
                required: ["contact_phone", "text"],
              },
              outputSchema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["sent", "error"] },
                },
              },
            },
          ],
        };
        break;

      case "tools/call":
        if (!params || !params.name) {
          throw new Error("Missing tool name");
        }

        // Dispatch tools
        switch (params.name) {
          case "list_conversations":
            result = await tools.listConversations(supabase, orgId, params.arguments?.limit);
            break;
          case "get_conversation":
            result = await tools.getConversation(
              supabase,
              orgId,
              params.arguments?.contact_phone,
              params.arguments?.limit,
              params.arguments?.account_phone
            );
            break;
          case "search_contacts":
            result = await tools.searchContacts(
              supabase,
              orgId,
              params.arguments?.name,
              params.arguments?.number
            );
            break;
          case "list_accounts":
            result = await tools.listAccounts(supabase, orgId);
            break;
          case "send_message":
            result = await tools.sendMessage(
              supabase,
              orgId,
              params.arguments?.contact_phone,
              params.arguments?.text,
              params.arguments?.account_phone
            );
            break;
          default:
            throw new Error(`Unknown tool: ${params.name}`);
        }
        break;

      default:
        throw new Error(`Method not supported: ${method}`);
    }

    return c.json({
      jsonrpc: "2.0",
      id: id,
      result: result,
    });

  } catch (error: unknown) {
    log.error("MCP Error", error);
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    return c.json({
      jsonrpc: "2.0",
      id: id,
      error: {
        code: -32603,
        message: message,
        data: stack,
      },
    });
  }
});

Deno.serve(app.fetch);
