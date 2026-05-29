import { createUnsecureClient, type Database } from "../_shared/supabase.ts";
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
  const token = req.headers.get("Authorization")?.replace("Bearer ", "")
    || req.headers.get("api-key");

  if (!token) throw new Error("Missing Authorization header");

  const supabase = createUnsecureClient();

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
    const url = new URL(req.url);
    const path = url.pathname.split("/").pop();

    // Public endpoints (no auth required)
    if (path === "ping") {
      const supabase = createUnsecureClient();
      const { count } = await supabase.from("organizations").select("id", { count: "exact", head: true });
      return json({ status: "ok", timestamp: new Date().toISOString(), db: count !== null ? "connected" : "error" });
    }

    if (path === "config") {
      return json({
        plugins: {
          stripe: !!Deno.env.get("STRIPE_SECRET_KEY"),
          "migrate-twilio": true,
        },
      });
    }

    const { supabase, orgId } = await authenticate(req);
    const method = req.method;
    const body = method !== "GET" ? await req.json().catch(() => ({})) : {};
    const params = Object.fromEntries(url.searchParams);

    // Common params
    const common = { supabase, orgId, allowedAccounts: [] as string[], allowedContacts: [] as string[] };

    switch (path) {
      // GET /api/health — validate Meta tokens for all connected accounts
      case "health": {
        if (method === "GET") {
          const { data: addresses } = await supabase
            .from("organizations_addresses")
            .select("address, extra, status")
            .eq("organization_id", orgId)
            .eq("service", "whatsapp")
            .eq("status", "connected");

          const { getSecret } = await import("../_shared/secrets.ts");
          const results = await Promise.all(
            (addresses || []).map(async (addr) => {
              const extra = addr.extra as Record<string, unknown> | null;
              const phone = (extra?.phone_number as string) || addr.address;
              const name = (extra?.verified_name as string) || "Unknown";
              const storedToken = await getSecret(supabase, orgId, addr.address, "access_token");
              const systemToken = Deno.env.get("META_SYSTEM_USER_ACCESS_TOKEN");
              const token = storedToken || systemToken;

              if (!token) {
                return { phone, name, address: addr.address, status: "error", error: "No access token" };
              }

              try {
                const res = await fetch(
                  `https://graph.facebook.com/v24.0/${addr.address}?fields=verified_name,quality_rating,messaging_limit_tier`,
                  { headers: { Authorization: `Bearer ${token}` } },
                );
                const data = await res.json();
                if (data.error) {
                  return { phone, name, address: addr.address, status: "error", error: data.error.message };
                }
                return {
                  phone,
                  name: data.verified_name || name,
                  address: addr.address,
                  status: "active",
                  quality: data.quality_rating || "unknown",
                  messaging_limit: data.messaging_limit_tier || "unknown",
                };
              } catch (err) {
                return { phone, name, address: addr.address, status: "error", error: (err as Error).message };
              }
            }),
          );

          return json({ accounts: results });
        }
        return error("Method not allowed", 405);
      }

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
      // GET /api/conversation?group_id=...&limit=50&account_phone=...
      case "conversation": {
        if (method === "GET") {
          if (!params.contact_phone && !params.group_id) return error("contact_phone or group_id is required");
          const result = await tools.fetchConversation({
            ...common,
            contactPhone: params.contact_phone,
            groupId: params.group_id,
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
      // POST /api/messages { group_id, text?, template?, account_phone? }
      case "messages": {
        if (method === "POST") {
          const { contact_phone, group_id, text, template, account_phone } = body;
          if (!contact_phone && !group_id) return error("contact_phone or group_id is required");

          let content;
          if (template) {
            content = { kind: "template", type: "data", version: "1", data: template };
          } else if (text) {
            content = { kind: "text", type: "text", version: "1", text };
          } else {
            return error("Either text or template is required");
          }

          const result = await tools.sendMessage({
            ...common,
            contactPhone: contact_phone,
            groupId: group_id,
            content,
            accountPhone: account_phone,
          });
          return json(result);
        }

        // GET /api/messages?contact_phone=...&limit=50
        // GET /api/messages?group_id=...&limit=50
        if (method === "GET") {
          if (!params.contact_phone && !params.group_id) return error("contact_phone or group_id is required");
          const result = await tools.fetchConversation({
            ...common,
            contactPhone: params.contact_phone,
            groupId: params.group_id,
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
            "GET  /api/conversation?group_id=...&limit=50",
            "GET  /api/contacts?name=...&number=...&limit=10",
            "POST /api/messages { contact_phone, text, account_phone? }",
            "POST /api/messages { group_id, text, account_phone? }",
            "POST /api/messages { contact_phone|group_id, template: {...}, account_phone? }",
            "GET  /api/messages?contact_phone=...&limit=50",
            "GET  /api/messages?group_id=...&limit=50",
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
