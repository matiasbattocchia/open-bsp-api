// Management for the 'whatsapp-web' service (self-hosted whatsmeow bridge,
// open-bsp-whatsmeow). Mirrors whatsapp-management/instagram-management: the
// UI talks to this function, never to the bridge directly; the bridge accepts
// server-to-server calls only.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Context, Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import { type User } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import { Json } from "../_shared/db_types.ts";
import { createClient, createUnsecureClient } from "../_shared/supabase.ts";

const BRIDGE_URL = Deno.env.get("WHATSAPP_WEB_URL") ?? "";
const BRIDGE_TOKEN = Deno.env.get("WHATSAPP_WEB_TOKEN") ?? "";

// The bridge authenticates session-lifecycle callbacks (paired, logged out)
// with the shared bridge token instead of a user JWT.
const PUBLIC_SUFFIXES = ["/sessions/events"];

type AppEnv = {
  Variables: {
    supabase: ReturnType<typeof createClient>;
    user: User;
  };
};

const app = new Hono<AppEnv>();

app.use("*", cors());

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    log.error(
      `${c.req.method} ${c.req.path} → ${err.status}: ${err.message}`,
      err.cause,
    );
    return c.json(
      { message: err.message, cause: err.cause as Json },
      err.status,
    );
  }

  log.error(`Unhandled error on ${c.req.method} ${c.req.path}`, err);
  return c.json({ message: "Internal Server Error" }, 500);
});

// Validate the user JWT (skipped for the bridge-token routes above).
app.use("*", async (c, next) => {
  if (PUBLIC_SUFFIXES.some((suffix) => c.req.path.endsWith(suffix))) {
    await next();
    return;
  }

  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    throw new HTTPException(401, { message: "Missing authorization token" });
  }

  const client = createClient(c.req.raw);
  const { data: { user }, error: userError } = await client.auth.getUser();

  if (userError || !user) {
    throw new HTTPException(401, { message: "Invalid JWT", cause: userError });
  }

  c.set("user", user);
  c.set("supabase", client);

  await next();
});

/**
 * Requires the user to have one of the given roles in the organization. The
 * organization_id comes from the JSON body on write methods and from the
 * query string on GET/DELETE.
 */
function requireRoles(roles: Array<"member" | "admin" | "owner">) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const organization_id = c.req.method === "GET" || c.req.method === "DELETE"
      ? c.req.query("organization_id")
      : (await c.req.raw.clone().json()).organization_id;

    if (!organization_id) {
      throw new HTTPException(400, { message: "organization_id is required" });
    }

    const client = c.get("supabase");
    const user = c.get("user");

    const { error: agentError, data: agent } = await client
      .from("agents")
      .select("organization_id")
      .eq("user_id", user.id)
      .eq("organization_id", organization_id)
      .in("extra->>role", roles)
      .maybeSingle();

    if (agentError || !agent) {
      throw new HTTPException(403, {
        message: `Not authorized for organization ${organization_id}`,
        cause: agentError,
      });
    }

    await next();
  };
}

async function callBridge(
  method: string,
  path: string,
  body?: Json,
): Promise<Json> {
  if (!BRIDGE_URL) {
    throw new HTTPException(503, {
      message: "WHATSAPP_WEB_URL is not configured",
    });
  }

  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new HTTPException(502, {
      message: `Bridge responded ${response.status}`,
      cause: payload,
    });
  }

  return payload;
}

// Start pairing: the bridge creates a session and returns a QR code string
// (and/or a phone pairing code) for the UI to render.
app.post(
  "/whatsapp-web-management/sessions",
  requireRoles(["owner"]),
  async (c) => {
    const { organization_id, phone_number } = await c.req.json<{
      organization_id: string;
      phone_number?: string;
    }>();

    const result = await callBridge("POST", "/sessions", {
      organization_id,
      phone_number,
    });

    return Response.json(result);
  },
);

// Pairing/connection status for channel health.
app.get(
  "/whatsapp-web-management/sessions/:address",
  requireRoles(["member", "admin", "owner"]),
  async (c) => {
    const address = c.req.param("address") ?? "";
    const result = await callBridge(
      "GET",
      `/sessions/${encodeURIComponent(address)}`,
    );

    return Response.json(result);
  },
);

// Logout: the bridge logs the device out and deletes it from its session
// store; the organizations_addresses row is marked disconnected here.
app.delete(
  "/whatsapp-web-management/sessions/:address",
  requireRoles(["owner"]),
  async (c) => {
    const organization_id = c.req.query("organization_id")!;
    const address = c.req.param("address") ?? "";

    await callBridge(
      "DELETE",
      `/sessions/${encodeURIComponent(address)}`,
    );

    await createUnsecureClient()
      .from("organizations_addresses")
      .update({ status: "disconnected" })
      .eq("organization_id", organization_id)
      .eq("service", "whatsapp-web")
      .eq("address", address)
      .throwOnError();

    return c.json({});
  },
);

// Session lifecycle callbacks from the bridge (auth: shared bridge token).
// The bridge stays a pure WhatsApp I/O process; all onboarding-related DB
// writes happen here.
app.post("/whatsapp-web-management/sessions/events", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (!BRIDGE_TOKEN || token !== BRIDGE_TOKEN) {
    throw new HTTPException(401, { message: "Invalid bridge token" });
  }

  const { event, organization_id, address, extra } = await c.req.json<{
    event: "connected" | "logged_out";
    organization_id: string;
    /** The session's own number (canonical bare digits) */
    address: string;
    /** e.g. { device_jid } */
    extra?: Record<string, Json>;
  }>();

  const client = createUnsecureClient();

  if (event === "connected") {
    await client
      .from("organizations_addresses")
      .upsert({
        organization_id,
        service: "whatsapp-web",
        address,
        status: "connected",
        extra,
      })
      .throwOnError();
  } else if (event === "logged_out") {
    await client
      .from("organizations_addresses")
      .update({ status: "disconnected" })
      .eq("organization_id", organization_id)
      .eq("service", "whatsapp-web")
      .eq("address", address)
      .throwOnError();

    // Surface the main real-world failure mode of an unofficial channel: the
    // UI prompts a re-pair based on this log/status.
    await client
      .from("logs")
      .insert({
        organization_id,
        organization_address: address,
        category: "session",
        service: "whatsapp-web",
        level: "warning",
        message: "WhatsApp Web session logged out; re-pairing required",
        metadata: (extra ?? {}) as Json,
      })
      .throwOnError();
  } else {
    throw new HTTPException(400, { message: `Unknown event ${event}` });
  }

  return c.json({});
});

Deno.serve(app.fetch);
