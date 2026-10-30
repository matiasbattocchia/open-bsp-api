// Remote MCP server (Streamable HTTP). Two auth paths, both RLS-scoped:
//  • Humans (Claude Code/Desktop, ChatGPT): OAuth 2.1 via Supabase Auth's
//    native OAuth server (<SUPABASE_URL>/auth/v1) with dynamic client
//    registration — the bearer is a Supabase JWT, discovered through the
//    RFC 9728 protected-resource metadata below.
//  • Servers/chatbots: an org API key, in the `api-key` header or (legacy)
//    as the Authorization bearer token.
import { Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  createApiClientFromKey,
  createClient,
  type Database,
} from "../_shared/supabase.ts";
import { authBaseUrl, functionsBaseUrl } from "../_shared/urls.ts";
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

const RESOURCE = () => `${functionsBaseUrl()}/mcp`;
const RESOURCE_METADATA = () =>
  `${functionsBaseUrl()}/mcp/.well-known/oauth-protected-resource`;

const app = new Hono<{ Variables: Variables }>();

app.use("*", cors());

// OAuth Protected Resource Metadata (RFC 9728) — public; points MCP clients
// at the authorization server (Supabase Auth's native OAuth 2.1 server, which
// supports dynamic client registration). Registered BEFORE the auth
// middleware so it stays unauthenticated.
app.get("/mcp/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: RESOURCE(),
    authorization_servers: [authBaseUrl()],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
    resource_name: "OpenBSP MCP",
  }));

// The server is stateless: there is no session to stream server-initiated
// messages on (GET) or to terminate (DELETE), so both get the spec's 405
// instead of an SSE stream that idles until the wall-clock limit kills the
// worker. Answered before auth — there is nothing to authorize.
app.on(["GET", "DELETE"], "*", (c) => {
  c.header("Allow", "POST");
  return c.json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  }, 405);
});

// Auth middleware — resolves the caller to an org-scoped Supabase client.
// A 401 carries the WWW-Authenticate challenge so an MCP connector can
// discover the authorization server and start the OAuth flow.
app.use("*", async (c, next) => {
  const unauthorized = (message: string, err?: unknown) => {
    log.error(message, err);
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${RESOURCE_METADATA()}"`,
    );
    return c.json({ error: message }, 401);
  };

  try {
    const bearer = (c.req.header("Authorization") ?? "").replace(
      /^Bearer\s+/i,
      "",
    );
    const looksLikeJwt = bearer.split(".").length === 3;
    // API key: `api-key` header, or (legacy) a non-JWT Authorization bearer.
    const apiKey = c.req.header("api-key") ??
      (bearer && !looksLikeJwt ? bearer : "");

    if (apiKey) {
      const supabase = createApiClientFromKey(apiKey);

      const { data: key, error: apiKeyError } = await supabase
        .from("api_keys")
        .select("organization_id")
        .eq("key", apiKey)
        .maybeSingle();

      if (apiKeyError || !key) {
        return unauthorized("API key not authorized", apiKeyError);
      }

      c.set("supabase", supabase);
      c.set("orgId", key.organization_id);
    } else if (looksLikeJwt) {
      // Human via OAuth (or a plain Supabase session JWT).
      const supabase = createClient(c.req.raw);
      const { data, error } = await supabase.auth.getUser(bearer);

      if (error || !data.user) {
        return unauthorized("Invalid token", error);
      }

      // Org-scope the session: the user's oldest current membership. RLS
      // already hides organizations they have left; the deleted_at filter
      // states it here rather than relying on it.
      const { data: agents, error: agentsError } = await supabase
        .from("agents")
        .select("organization_id")
        .eq("user_id", data.user.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: true })
        .limit(1);

      if (agentsError || !agents?.length) {
        return unauthorized("No organization for this user", agentsError);
      }

      c.set("supabase", supabase);
      c.set("orgId", agents[0].organization_id);
    } else {
      return unauthorized("Missing credentials");
    }

    // Parse allowed headers
    const allowedContactsHeader = c.req.header("Allowed-Contacts");
    const allowedAccountsHeader = c.req.header("Allowed-Accounts");

    const allowedContacts = allowedContactsHeader?.split(",").map((p) =>
      p.replace(/\D/g, "")
    ).filter(Boolean) || [];
    const allowedAccounts = allowedAccountsHeader?.split(",").map((p) =>
      p.replace(/\D/g, "")
    ).filter(Boolean) || [];

    c.set("allowedContacts", allowedContacts);
    c.set("allowedAccounts", allowedAccounts);

    await next();
  } catch (err: unknown) {
    const message = err instanceof Error
      ? err.message
      : "Authentication failed";

    return unauthorized(message, err);
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
    version: "1.2.0",
  });

  server.registerTool(
    "list_conversations",
    {
      description: "Get recent active conversations for a specific account.",
      inputSchema: {
        limit: z.number().optional().describe(
          "Max conversations (default: 10)",
        ),
        account_phone: z.string().optional().describe(
          "Account phone (required if >1 account)",
        ),
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

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "fetch_conversation",
    {
      description:
        "Fetch messages and status for a specific contact conversation.",
      inputSchema: {
        contact_phone: z.string().describe("Contact's phone number"),
        account_phone: z.string().optional().describe(
          "Account phone (required if >1 account)",
        ),
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

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "search_contacts",
    {
      description:
        "Find contacts by name or phone number. Returns all contacts if no filters provided.",
      inputSchema: {
        name: z.string().optional().describe(
          "Name to search (case-insensitive, partial match)",
        ),
        number: z.string().optional().describe(
          "Phone number to search (partial match)",
        ),
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

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
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

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "list_templates",
    {
      description: "List available WhatsApp templates.",
      inputSchema: {
        account_phone: z.string().optional().describe(
          "Account phone (required if >1 account)",
        ),
      },
    },
    async ({ account_phone }) => {
      const result = await tools.listTemplates({
        supabase,
        orgId,
        accountPhone: account_phone,
        allowedAccounts,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "fetch_template",
    {
      description: "Fetch details of a specific template.",
      inputSchema: {
        template_id: z.string().describe("Template ID"),
        account_phone: z.string().optional().describe(
          "Account phone (required if >1 account)",
        ),
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

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send a text or template message. Enforces 24h service window for text messages. A text message holds at most 4096 characters: send longer text as several messages.",
      inputSchema: {
        contact_phone: z.string().describe("Contact's phone number"),
        content: z.any().describe("Message content (text or template object)"),
        account_phone: z.string().optional().describe(
          "Account phone (required if >1 account)",
        ),
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

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
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

  const server = createMcpServer(
    supabase,
    orgId,
    allowedContacts,
    allowedAccounts,
  );
  const transport = new WebStandardStreamableHTTPServerTransport();

  await server.connect(transport);

  // The transport consumes the body; keep a copy to name the JSON-RPC method
  // if the request is rejected.
  const request = c.req.raw.clone();
  const response = await transport.handleRequest(c.req.raw);

  // Transport rejections (400s) carry their reason only in the response body.
  // Credentials headers are deliberately not logged.
  if (response.status >= 400) {
    const rpcMethod = await request.json()
      .then((m) => Array.isArray(m) ? m.map((x) => x?.method) : m?.method)
      .catch(() => "<unparseable body>");

    log.warn("MCP request rejected", {
      status: response.status,
      method: c.req.method,
      contentType: c.req.header("Content-Type"),
      protocolVersion: c.req.header("MCP-Protocol-Version"),
      rpcMethod,
      body: await response.clone().text(),
    });
  }

  return response;
});

Deno.serve(app.fetch);
