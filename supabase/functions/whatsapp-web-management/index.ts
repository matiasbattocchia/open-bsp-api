// Management for the 'whatsapp-web' service (self-hosted whatsmeow bridge,
// open-bsp-whatsmeow). Mirrors whatsapp-management/instagram-management: the
// UI talks to this function, never to the bridge directly; the bridge accepts
// server-to-server calls only.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import * as log from "../_shared/logger.ts";
import { Json } from "../_shared/db_types.ts";
import { createClient, createUnsecureClient } from "../_shared/supabase.ts";
import {
  canConnect,
  isQuotaError,
  recordRefusedConnection,
} from "../_shared/connections.ts";
import {
  type ManagementEnv,
  requireRoles,
  requireRolesOrOwnAddress,
  requireScope,
} from "../_shared/management_auth.ts";

const BRIDGE_URL = Deno.env.get("WHATSAPP_WEB_URL") ?? "";
const BRIDGE_TOKEN = Deno.env.get("WHATSAPP_WEB_TOKEN") ?? "";

// The bridge authenticates session-lifecycle callbacks (paired, logged out)
// with the shared bridge token instead of a user JWT.
const PUBLIC_SUFFIXES = ["/sessions/events"];

const app = new Hono<ManagementEnv>();

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
//
// agent_id decides the scope: absent pairs the ORG'S number (shared inbox,
// admin+); set pairs a personal one — the address row will carry it, making
// its conversations visible to that member alone — and any member may pair
// their own (see requireScope).
app.post(
  "/whatsapp-web-management/sessions",
  requireRoles(["member", "admin", "owner"]),
  async (c) => {
    const { organization_id, phone_number, agent_id } = await c.req.json<{
      organization_id: string;
      phone_number?: string;
      agent_id?: string;
    }>();

    await requireScope(
      c,
      organization_id,
      agent_id,
      requireRoles(["admin", "owner"]),
    );

    // Before a QR code is ever shown: a pairing the cap then refuses would
    // leave the phone linked to a session that is not connected here.
    const client = createUnsecureClient();
    if (
      !(await canConnect(client, organization_id, "whatsapp-web", {
        address: phone_number?.replace(/\D/g, ""),
      }))
    ) {
      await recordRefusedConnection(
        client,
        organization_id,
        "whatsapp-web",
        phone_number?.replace(/\D/g, ""),
      );
      throw new HTTPException(402, {
        message: "Usage limit reached for organizations_addresses",
      });
    }

    const result = await callBridge("POST", "/sessions", {
      organization_id,
      phone_number,
      agent_id,
    });

    return Response.json(result);
  },
);

// Poll an in-progress pairing: QR codes rotate every ~20s, so the UI polls
// this (every 3-5s) for the latest code and for completion
// (status: pending | paired | error).
app.get(
  "/whatsapp-web-management/sessions/pending/:id",
  // Member+: whoever legitimately started a pairing (a member, for their own
  // personal session) has to be able to poll it; the id is unguessable and
  // the payload is just QR/status.
  requireRoles(["member", "admin", "owner"]),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const result = await callBridge(
      "GET",
      `/sessions/pending/${encodeURIComponent(id)}`,
    );

    return Response.json(result);
  },
);

// Pairing/connection status for channel health. Own-address carve-out: a
// member reads their own personal session's health.
app.get(
  "/whatsapp-web-management/sessions/:address",
  requireRolesOrOwnAddress("whatsapp-web", requireRoles(["admin", "owner"])),
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
  requireRolesOrOwnAddress("whatsapp-web", requireRoles(["admin", "owner"])),
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

  const { event, organization_id, address, agent_id, extra } = await c.req
    .json<{
      event: "connected" | "logged_out";
      organization_id: string;
      /** The session's own number (canonical bare digits) */
      address: string;
      /**
       * Echoed from pairing. Set makes the address USER-SCOPED — its
       * conversations visible to that member alone; absent is the org's
       * shared inbox.
       */
      agent_id?: string;
      /** e.g. { device_jid } */
      extra?: Record<string, Json>;
    }>();

  const client = createUnsecureClient();

  if (event === "connected") {
    const { error } = await client
      .from("organizations_addresses")
      .upsert({
        organization_id,
        service: "whatsapp-web",
        address,
        agent_id: agent_id ?? null,
        status: "connected",
        // For whatsapp-web the address IS the bare phone number (unlike the
        // Cloud API, where address is an opaque phone_number_id). Mirror it into
        // extra.phone_number so consumers that key off that field work across
        // both services — notably the MCP `Allowed-Accounts` filter, which
        // matches on extra->>phone_number and would otherwise never match a
        // whatsapp-web account.
        extra: { ...extra, phone_number: address },
      });

    if (error) {
      if (!isQuotaError(error)) throw error;

      // Over the connections cap: a pairing that slipped past the check at
      // its start (another account connected meanwhile), or a session the
      // bridge brings back for an account disconnected here. Nobody is
      // watching, so the refusal is recorded for the organization, and the
      // session is logged out — kept, it would relay messages for an account
      // that is not connected.
      await recordRefusedConnection(
        client,
        organization_id,
        "whatsapp-web",
        address,
      );
      await callBridge("DELETE", `/sessions/${encodeURIComponent(address)}`)
        .catch((e) => log.error("Could not log out a refused session", e));

      return c.json({ error: error.message }, 402);
    }
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
