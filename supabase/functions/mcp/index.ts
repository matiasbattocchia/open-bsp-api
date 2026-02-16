import { Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js";
import { z } from "zod";
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

/**
 * Creates an McpServer instance with all tools registered.
 * A new server+transport is created per request (Edge Functions are stateless).
 */
function createMcpServer(
  supabase: SupabaseClient<Database>,
  orgId: string,
  allowedContacts: string[],
  allowedAccounts: string[],
) {
  const server = new McpServer({
    name: "open-bsp-mcp",
    version: "1.1.0",
  });

  server.registerTool(
    "list_conversations",
    {
      description: "Get recent active conversations for a specific account.",
      inputSchema: {
        limit: z.number().optional().describe("Max conversations (default: 10)"),
        account_phone: z.string().optional().describe("Account phone (required if >1 account)"),
      },
    },
    async ({ limit, account_phone }) => {
      const result = await tools.listConversations({
        supabase,
        orgId,
        limit,
        accountPhone: account_phone,
        allowedAccounts,
        allowedContacts,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "fetch_conversation",
    {
      description: "Fetch messages and status for a specific contact conversation.",
      inputSchema: {
        contact_phone: z.string().describe("Contact's phone number"),
        account_phone: z.string().optional().describe("Account phone (required if >1 account)"),
        limit: z.number().optional().describe("Max messages (default: 10)"),
      },
    },
    async ({ contact_phone, account_phone, limit }) => {
      const result = await tools.fetchConversation({
        supabase,
        orgId,
        contactPhone: contact_phone,
        limit,
        accountPhone: account_phone,
        allowedAccounts,
        allowedContacts,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "search_contacts",
    {
      description: "Find contacts by name or phone number. Returns all contacts if no filters provided.",
      inputSchema: {
        name: z.string().optional().describe("Name to search (case-insensitive, partial match)"),
        number: z.string().optional().describe("Phone number to search (partial match)"),
        limit: z.number().optional().describe("Max contacts (default: 10)"),
      },
    },
    async ({ name, number, limit }) => {
      const result = await tools.searchContacts({
        supabase,
        orgId,
        name,
        number,
        limit,
        allowedContacts,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "list_accounts",
    {
      description: "List connected WhatsApp accounts.",
      inputSchema: {},
    },
    async () => {
      const result = await tools.listAccounts({
        supabase,
        orgId,
        allowedAccounts,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "list_templates",
    {
      description: "List available WhatsApp templates.",
      inputSchema: {
        account_phone: z.string().optional().describe("Account phone (required if >1 account)"),
      },
    },
    async ({ account_phone }) => {
      const result = await tools.listTemplates({
        supabase,
        orgId,
        accountPhone: account_phone,
        allowedAccounts,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "fetch_template",
    {
      description: "Fetch details of a specific template.",
      inputSchema: {
        template_id: z.string().describe("Template ID"),
        account_phone: z.string().optional().describe("Account phone (required if >1 account)"),
      },
    },
    async ({ template_id, account_phone }) => {
      const result = await tools.fetchTemplate({
        supabase,
        orgId,
        templateId: template_id,
        accountPhone: account_phone,
        allowedAccounts,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "send_message",
    {
      description: "Send a text or template message. Enforces 24h service window for text messages.",
      inputSchema: {
        contact_phone: z.string().describe("Contact's phone number"),
        content: z.any().describe("Message content (text or template object)"),
        account_phone: z.string().optional().describe("Account phone (required if >1 account)"),
      },
    },
    async ({ contact_phone, content, account_phone }) => {
      const result = await tools.sendMessage({
        supabase,
        orgId,
        content,
        contactPhone: contact_phone,
        accountPhone: account_phone,
        allowedAccounts,
        allowedContacts,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  return server;
}

// Handle all MCP requests via Streamable HTTP
app.all("*", async (c) => {
  const supabase = c.get("supabase");
  const orgId = c.get("orgId");
  const allowedContacts = c.get("allowedContacts");
  const allowedAccounts = c.get("allowedAccounts");

  const server = createMcpServer(supabase, orgId, allowedContacts, allowedAccounts);
  const transport = new WebStandardStreamableHTTPServerTransport();

  await server.connect(transport);

  return transport.handleRequest(c.req.raw);
});

Deno.serve(app.fetch);
