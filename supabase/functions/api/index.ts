import { createApiClient, type Database } from "../_shared/supabase.ts";
import * as tools from "../mcp/tools.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey, api-key",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function error(message: string, status = 400) {
  return json({ error: message }, status);
}

/** Authenticate via api-key header → look up in api_keys table */
async function authenticate(req: Request): Promise<{ supabase: SupabaseClient<Database>; orgId: string }> {
  const supabase = createApiClient(req);
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");

  if (!token) throw new Error("Missing Authorization header");

  const { data: apiKey, error: err } = await supabase
    .from("api_keys")
    .select("organization_id")
    .eq("key", token)
    .maybeSingle();

  if (err || !apiKey) throw new Error("Invalid API key");

  return { supabase, orgId: apiKey.organization_id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { supabase, orgId } = await authenticate(req);
    const url = new URL(req.url);
    const path = url.pathname.split("/").pop();
    const method = req.method;
    const body = method !== "GET" ? await req.json().catch(() => ({})) : {};
    const params = Object.fromEntries(url.searchParams);

    // Common params
    const common = { supabase, orgId, allowedAccounts: [] as string[], allowedContacts: [] as string[] };

    switch (path) {
      // GET /api/conversations?limit=10&account_phone=...
      case "conversations": {
        if (method === "GET") {
          const result = await tools.listConversations({
            ...common,
            limit: Number(params.limit) || 10,
            accountPhone: params.account_phone,
          });
          return json(result);
        }
        return error("Method not allowed", 405);
      }

      // GET /api/conversation?contact_phone=...&limit=50&account_phone=...
      case "conversation": {
        if (method === "GET") {
          if (!params.contact_phone) return error("contact_phone is required");
          const result = await tools.fetchConversation({
            ...common,
            contactPhone: params.contact_phone,
            limit: Number(params.limit) || 50,
            accountPhone: params.account_phone,
          });
          return json(result);
        }
        return error("Method not allowed", 405);
      }

      // GET /api/contacts?name=...&number=...&limit=10
      case "contacts": {
        if (method === "GET") {
          const result = await tools.searchContacts({
            ...common,
            name: params.name,
            number: params.number,
            limit: Number(params.limit) || 10,
          });
          return json(result);
        }
        return error("Method not allowed", 405);
      }

      // GET /api/accounts
      case "accounts": {
        if (method === "GET") {
          const result = await tools.listAccounts(common);
          return json(result);
        }
        return error("Method not allowed", 405);
      }

      // POST /api/messages { contact_phone, text?, template?, account_phone? }
      case "messages": {
        if (method === "POST") {
          const { contact_phone, text, template, account_phone } = body;
          if (!contact_phone) return error("contact_phone is required");

          let content;
          if (template) {
            content = { kind: "template", type: "data", version: "1", template };
          } else if (text) {
            content = { kind: "text", type: "text", version: "1", text };
          } else {
            return error("Either text or template is required");
          }

          const result = await tools.sendMessage({
            ...common,
            contactPhone: contact_phone,
            content,
            accountPhone: account_phone,
          });
          return json(result);
        }

        // GET /api/messages?conversation_id=...&limit=50
        if (method === "GET") {
          if (!params.contact_phone) return error("contact_phone is required");
          const result = await tools.fetchConversation({
            ...common,
            contactPhone: params.contact_phone,
            limit: Number(params.limit) || 50,
            accountPhone: params.account_phone,
          });
          return json(result);
        }
        return error("Method not allowed", 405);
      }

      // GET /api/templates?account_phone=...
      case "templates": {
        if (method === "GET") {
          if (params.template_id) {
            const result = await tools.fetchTemplate({
              ...common,
              templateId: params.template_id,
              accountPhone: params.account_phone,
            });
            return json(result);
          }
          const result = await tools.listTemplates({
            ...common,
            accountPhone: params.account_phone,
          });
          return json(result);
        }
        return error("Method not allowed", 405);
      }

      default:
        return json({
          endpoints: [
            "GET  /api/accounts",
            "GET  /api/conversations?limit=10&account_phone=...",
            "GET  /api/conversation?contact_phone=...&limit=50",
            "GET  /api/contacts?name=...&number=...&limit=10",
            "POST /api/messages { contact_phone, text, account_phone? }",
            "POST /api/messages { contact_phone, template: {...}, account_phone? }",
            "GET  /api/messages?contact_phone=...&limit=50",
            "GET  /api/templates?account_phone=...",
            "GET  /api/templates?template_id=...&account_phone=...",
          ],
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    const status = message.includes("Invalid API key") || message.includes("Missing Authorization") ? 401 : 500;
    return error(message, status);
  }
});
