import { Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { streamSSE } from "jsr:@hono/hono/streaming";
import { createApiClient, type Database } from "../_shared/supabase.ts";
import * as log from "../_shared/logger.ts";
import * as tools from "./tools.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

// Hono context variables set by auth middleware
type Variables = {
  allowedContacts: string[];
  allowedAccounts: string[];
  orgId: string;
  supabase: SupabaseClient<Database>;
};

const app = new Hono<{ Variables: Variables }>();

app.use("*", cors());

// Auth middleware - validates API key and sets context variables
app.use("*", async (c, next) => {
  try {
    const supabase = createApiClient(c.req.raw);

    c.set("supabase", supabase);

    const token = c.req.header("Authorization")!.replace("Bearer ", "");

    const { data: apiKey, error: apiKeyError } = await supabase
      .from("api_keys")
      .select("organization_id")
      .eq("key", token)
      .maybeSingle();

    if (apiKeyError || !apiKey) {
      const message = `API key ${token} not authorized`;

      log.error(message, apiKeyError);

      return c.json({ error: message }, 403);
    }

    c.set("orgId", apiKey.organization_id);

    // Parse allowed headers
    const allowedContactsHeader = c.req.header("Allowed-Contacts");
    const allowedAccountsHeader = c.req.header("Allowed-Accounts");

    const allowedContacts = allowedContactsHeader?.split(",").map((p) => p.replace(/\D/g, "")).filter(Boolean) || [];
    const allowedAccounts = allowedAccountsHeader?.split(",").map((p) => p.replace(/\D/g, "")).filter(Boolean) || [];

    c.set("allowedContacts", allowedContacts);
    c.set("allowedAccounts", allowedAccounts);

    await next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Authentication failed";

    log.error(message, err);

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
  const allowedContacts = c.get("allowedContacts");
  const allowedAccounts = c.get("allowedAccounts");

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
            version: "1.1.0",
          },
        };
        break;

      case "notifications/initialized":
        return c.text("ok");

      case "ping":
        result = {};
        break;

      case "tools/list":
        result = {
          tools: [
            {
              name: "list_conversations",
              description: "Get recent active conversations for a specific account.",
              inputSchema: {
                type: "object",
                properties: {
                  limit: { type: "number", description: "Max conversations (default: 10)" },
                  account_phone: { type: "string", description: "Account phone (required if >1 account)" },
                },
              },
            },
            {
              name: "fetch_conversation",
              description: "Fetch messages and status for a specific contact conversation.",
              inputSchema: {
                type: "object",
                properties: {
                  contact_phone: { type: "string", description: "Contact's phone number" },
                  account_phone: { type: "string", description: "Account phone (required if >1 account)" },
                  limit: { type: "number", description: "Max messages (default: 10)" },
                },
                required: ["contact_phone"],
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
            },
            {
              name: "list_accounts",
              description: "List connected WhatsApp accounts.",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
            {
              name: "list_templates",
              description: "List available WhatsApp templates.",
              inputSchema: {
                type: "object",
                properties: {
                  account_phone: { type: "string", description: "Account phone (required if >1 account)" },
                }
              },
            },
            {
              name: "fetch_template",
              description: "Fetch details of a specific template.",
              inputSchema: {
                type: "object",
                properties: {
                  template_id: { type: "string" },
                },
                required: ["template_id"]
              },
            },
            {
              name: "send_message",
              description: "Send a text or template message. Enforces 24h service window for text messages.",
              inputSchema: {
                type: "object",
                properties: {
                  contact_phone: { type: "string", description: "Contact's phone number" },
                  content: {
                    type: "object",
                    description: "Message content.",
                    oneOf: [
                      {
                        description: "Text Message",
                        type: "object",
                        properties: {
                          version: { const: "1" },
                          type: { const: "text" },
                          kind: { const: "text" },
                          text: { type: "string" }
                        },
                        required: ["version", "type", "kind", "text"]
                      },
                      {
                        description: "Template Message",
                        type: "object",
                        properties: {
                          version: { const: "1" },
                          type: { const: "data" },
                          kind: { const: "template" },
                          data: {
                            type: "object",
                            properties: {
                              name: { type: "string" },
                              language: {
                                type: "object",
                                properties: {
                                  code: { type: "string" },
                                  policy: { const: "deterministic" }
                                },
                                required: ["code"]
                              },
                              components: { type: "array" }
                            },
                            required: ["name", "language"]
                          }
                        },
                        required: ["type", "kind", "data"]
                      }
                    ]
                  },
                  account_phone: { type: "string", description: "Account phone (required if >1 account)" },
                },
                required: ["contact_phone", "content"],
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
        try {
          switch (params.name) {
            case "list_conversations":
              result = await tools.listConversations({
                supabase,
                orgId,
                limit: params.arguments?.limit,
                accountPhone: params.arguments?.account_phone,
                allowedAccounts,
                allowedContacts
              });
              break;

            case "fetch_conversation":
              result = await tools.fetchConversation({
                supabase,
                orgId,
                contactPhone: params.arguments?.contact_phone,
                limit: params.arguments?.limit,
                accountPhone: params.arguments?.account_phone,
                allowedAccounts,
                allowedContacts
              });
              break;

            case "search_contacts":
              result = await tools.searchContacts({
                supabase,
                orgId,
                name: params.arguments?.name,
                number: params.arguments?.number,
                allowedContacts
              });
              break;

            case "list_accounts":
              result = await tools.listAccounts({
                supabase,
                orgId,
                allowedAccounts
              });
              break;

            case "send_message":
              result = await tools.sendMessage({
                supabase,
                orgId,
                content: params.arguments?.content,
                contactPhone: params.arguments?.contact_phone,
                accountPhone: params.arguments?.account_phone,
                allowedAccounts,
                allowedContacts
              });
              break;

            // Template Tools
            case "list_templates":
              result = await tools.listTemplates({
                supabase,
                orgId,
                accountPhone: params.arguments?.account_phone,
                allowedAccounts
              });
              break;

            case "fetch_template":
              result = await tools.fetchTemplate({
                supabase,
                orgId,
                templateId: params.arguments?.template_id,
                accountPhone: params.arguments?.account_phone,
                allowedAccounts
              });
              break;

            default:
              throw new Error(`Unknown tool: ${params.name}`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result = {
            isError: true,
            content: [{
              type: "text",
              text: `Error: ${errorMessage}`
            }]
          };
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
