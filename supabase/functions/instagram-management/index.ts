import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Context, Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import * as log from "../_shared/logger.ts";
import { Json } from "../_shared/db_types.ts";
import {
  ApiKeyRow,
  createApiClient,
  createClient,
  createUnsecureClient,
} from "../_shared/supabase.ts";
import {
  buildAuthorizeUrl,
  deleteInstagramData,
  disconnect,
  type InstagramLoginPayload,
  parseSignedRequest,
  performInstagramLogin,
  refreshTokens,
} from "./login.ts";
import { type User } from "@supabase/supabase-js";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Routes that do not use the user/API-key auth middleware. Each has its own
// auth: an onboarding token, the service-role key, or a signed_request HMAC.
// `authorize-url` only composes the public OAuth URL (client_id + scopes + the
// caller-supplied redirect_uri/state), so it is safe to leave open — the public
// onboarding-link page needs it without a session.
const PUBLIC_SUFFIXES = [
  "/authorize-url",
  "/onboard",
  "/refresh-tokens",
  "/deauthorize",
  "/data-deletion",
  "/data-deletion/status",
];

type AppEnv = {
  Variables: {
    supabase: ReturnType<typeof createClient>;
    user: User;
    token: string;
    apiKey: ApiKeyRow;
  };
};

const app = new Hono<AppEnv>();

app.use("*", cors());

// Surface thrown errors (and their `cause`) to the client and logs. Hono's
// default handler only serializes an HTTPException's `message`, discarding the
// `cause` where upstream details (e.g. the Graph API error) live.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    log.error(err.message, err.cause);
    return c.json(
      { message: err.message, cause: err.cause as Json },
      err.status,
    );
  }

  log.error("Unhandled error", err);
  return c.json({ message: "Internal Server Error" }, 500);
});

// Validate user or API key (skipped for the public routes above).
app.use("*", async (c, next) => {
  if (PUBLIC_SUFFIXES.some((suffix) => c.req.path.endsWith(suffix))) {
    await next();
    return;
  }

  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    throw new HTTPException(401, { message: "Missing authorization token" });
  }

  c.set("token", token);

  // if token looks like JWT, try user
  if (token.startsWith("eyJ")) {
    const client = createClient(c.req.raw);

    const { data: { user }, error: userError } = await client.auth.getUser();

    if (userError || !user) {
      log.error("Invalid JWT", userError);

      throw new HTTPException(401, {
        message: "Invalid JWT",
        cause: userError,
      });
    }

    c.set("user", user);
    c.set("supabase", client);

    await next();
    return;
  }

  const client = createApiClient(c.req.raw);

  const { data: apiKey, error: apiKeyError } = await client
    .from("api_keys")
    .select()
    .eq("key", token)
    .maybeSingle();

  if (apiKeyError || !apiKey) {
    log.error("Invalid API key", apiKeyError);

    throw new HTTPException(401, {
      message: "Invalid API key",
      cause: apiKeyError,
    });
  }

  c.set("apiKey", apiKey);
  c.set("supabase", client);

  await next();
});

// Require roles middleware factory (identical to whatsapp-management).
function requireRoles(roles: Array<"member" | "admin" | "owner">) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const client = c.get("supabase");

    // Clone the request to read the body without consuming the stream.
    const body = await c.req.raw.clone().json();
    const organization_id = body.organization_id;

    const user = c.get("user");

    if (user) {
      const { error: agentError, data: agent } = await client
        .from("agents")
        .select("organization_id")
        .eq("user_id", user.id)
        .eq("organization_id", organization_id)
        .in("extra->>role", roles)
        .maybeSingle();

      if (agentError || !agent) {
        throw new HTTPException(403, {
          message:
            `User ${user.id} not authorized for organization ${organization_id}. Allowed roles: ${
              roles.join(", ")
            }`,
          cause: agentError,
        });
      }

      await next();
      return;
    }

    const apiKey = c.get("apiKey")!;

    if (
      organization_id !== apiKey.organization_id || !roles.includes(apiKey.role)
    ) {
      throw new HTTPException(403, {
        message:
          `API key not authorized for organization ${organization_id}. Allowed roles: ${
            roles.join(", ")
          }`,
      });
    }

    await next();
  };
}

// Authorize URL helper — centralizes client_id + scopes for the frontend.
app.get("/instagram-management/authorize-url", (c) => {
  const redirect_uri = c.req.query("redirect_uri");
  const state = c.req.query("state");
  const application_id = c.req.query("application_id");

  if (!redirect_uri) {
    throw new HTTPException(400, {
      message: "Missing 'redirect_uri' query param",
    });
  }

  return c.json({
    url: buildAuthorizeUrl(redirect_uri, state, application_id),
  });
});

// Connect an account (in-app flow).
app.post(
  "/instagram-management/signup",
  requireRoles(["owner"]),
  async (c) => {
    const payload = await c.req.json<InstagramLoginPayload>();
    log.info("Instagram login payload", { ...payload, code: "***" });

    // Users may not modify organizations_addresses directly; use the unsecure
    // client now that the role check has passed.
    const client = createUnsecureClient();

    try {
      const address = await performInstagramLogin(client, payload);
      return c.json(address);
    } catch (error) {
      if (error instanceof HTTPException) {
        log.error(error.message, error);

        await client
          .from("logs")
          .insert({
            organization_id: payload.organization_id,
            category: "instagram_login",
            level: "error",
            message: error.message,
            metadata: error.cause as Json,
          })
          .throwOnError();
      } else {
        log.error("Instagram login failed", error);
      }

      throw error;
    }
  },
);

// Disconnect an account.
app.delete(
  "/instagram-management/signup",
  requireRoles(["owner"]),
  async (c) => {
    const payload = await c.req.json<
      { organization_id: string; ig_user_id: string }
    >();
    log.info("Instagram disconnect payload", payload);

    const client = createUnsecureClient();

    const address = await disconnect(client, payload);

    return c.json(address);
  },
);

// Public onboard routes (token-based, no auth header).

app.get("/instagram-management/onboard", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    throw new HTTPException(400, { message: "Missing 'token' query param" });
  }

  const client = createUnsecureClient();

  const { data, error } = await client
    .from("onboarding_tokens")
    .select("id, organization_id, organizations(name)")
    .eq("id", token)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !data) {
    return c.json({ valid: false });
  }

  return c.json({
    valid: true,
    organization_name: data.organizations?.name,
  });
});

app.post("/instagram-management/onboard", async (c) => {
  const body = await c.req.json<
    {
      token: string;
      code: string;
      redirect_uri: string;
      application_id?: string;
    }
  >();

  if (!body.token) {
    throw new HTTPException(400, { message: "Missing 'token' body param" });
  }

  log.info("Public Instagram onboard payload", { ...body, code: "***" });

  const client = createUnsecureClient();

  // Atomically validate and mark the onboarding token as used.
  const { data: tokenData, error: tokenError } = await client
    .from("onboarding_tokens")
    .update({ status: "used", used_at: new Date().toISOString() })
    .eq("id", body.token)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .select("organization_id")
    .maybeSingle();

  if (tokenError || !tokenData) {
    throw new HTTPException(400, {
      message: "Invalid or expired onboarding token",
    });
  }

  const payload: InstagramLoginPayload = {
    code: body.code,
    redirect_uri: body.redirect_uri,
    organization_id: tokenData.organization_id,
    application_id: body.application_id,
  };

  try {
    const address = await performInstagramLogin(client, payload);
    return c.json(address);
  } catch (error) {
    // Revert the token on failure so the user can retry.
    await client
      .from("onboarding_tokens")
      .update({ status: "active", used_at: null })
      .eq("id", body.token);

    if (error instanceof HTTPException) {
      log.error(error.message, error);

      await client
        .from("logs")
        .insert({
          organization_id: tokenData.organization_id,
          category: "instagram_login",
          level: "error",
          message: error.message,
          metadata: error.cause as Json,
        })
        .throwOnError();
    } else {
      log.error("Public Instagram onboard failed", error);
    }

    throw error;
  }
});

// Token refresh (invoked by the daily cron with the service-role key).
app.post("/instagram-management/refresh-tokens", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const client = createUnsecureClient();
  const summary = await refreshTokens(client);

  return c.json(summary);
});

// Meta compliance callbacks (authenticated via signed_request HMAC).

app.post("/instagram-management/deauthorize", async (c) => {
  const body = await c.req.parseBody();
  const signedRequest = body["signed_request"];

  if (typeof signedRequest !== "string") {
    throw new HTTPException(400, { message: "Missing 'signed_request'" });
  }

  const payload = await parseSignedRequest(signedRequest);

  if (!payload?.user_id) {
    throw new HTTPException(400, { message: "Invalid signed_request" });
  }

  log.info("Instagram deauthorize", { user_id: payload.user_id });

  const client = createUnsecureClient();

  await client
    .from("organizations_addresses")
    .update({ status: "disconnected" })
    .eq("address", payload.user_id)
    .eq("service", "instagram");

  return c.json({ success: true });
});

app.post("/instagram-management/data-deletion", async (c) => {
  const body = await c.req.parseBody();
  const signedRequest = body["signed_request"];

  if (typeof signedRequest !== "string") {
    throw new HTTPException(400, { message: "Missing 'signed_request'" });
  }

  const payload = await parseSignedRequest(signedRequest);

  if (!payload?.user_id) {
    throw new HTTPException(400, { message: "Invalid signed_request" });
  }

  log.info("Instagram data deletion request", { user_id: payload.user_id });

  const client = createUnsecureClient();
  await deleteInstagramData(client, payload.user_id);

  // Meta requires a JSON response with a status URL and a confirmation code.
  const confirmation_code = crypto.randomUUID();
  const origin = new URL(c.req.url).origin;
  const url =
    `${origin}/instagram-management/data-deletion/status?code=${confirmation_code}`;

  return c.json({ url, confirmation_code });
});

app.get("/instagram-management/data-deletion/status", (c) => {
  const code = c.req.query("code");

  return c.json({
    status: "Instagram data deletion request processed.",
    confirmation_code: code,
  });
});

Deno.serve(app.fetch);
