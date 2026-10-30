import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import * as log from "../_shared/logger.ts";
import { canConnect } from "../_shared/connections.ts";
import { Json } from "../_shared/db_types.ts";
import {
  createApiClient,
  createClient,
  createUnsecureClient,
} from "../_shared/supabase.ts";
import {
  buildAuthorizeUrl,
  getWebhook,
  TikTokError,
  updateWebhook,
} from "../_shared/tiktok.ts";
import {
  disconnect,
  performTikTokLogin,
  refreshTokens,
  type TikTokLoginPayload,
} from "./login.ts";
import {
  type ManagementEnv,
  ownsAddress,
  requireRoles,
  requireScope,
} from "../_shared/management_auth.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// Routes that do not use the user/API-key auth middleware. Each has its own
// auth: an onboarding token or the service-role key. `authorize-url` only
// composes the public OAuth URL (client_key + scopes + the caller-supplied
// redirect_uri/state), so it is safe to leave open — the public
// onboarding-link page needs it without a session.
const PUBLIC_SUFFIXES = [
  "/authorize-url",
  "/onboard",
  "/refresh-tokens",
  "/webhook",
];

type AppEnv = ManagementEnv;

const app = new Hono<AppEnv>();

app.use("*", cors());

// Surface thrown errors (and their `cause`) to the client and logs. Hono's
// default handler only serializes an HTTPException's `message`, discarding the
// `cause` where upstream details (e.g. TikTok's envelope) live. TikTok
// refusing a call is a bad gateway.
app.onError((err, c) => {
  if (err instanceof TikTokError) {
    err = new HTTPException(502, { message: err.message, cause: err.cause });
  }

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

// Authorize URL helper — centralizes client_key + scopes for the frontend.
app.get("/tiktok-management/authorize-url", (c) => {
  const redirect_uri = c.req.query("redirect_uri");
  const state = c.req.query("state");

  if (!redirect_uri) {
    throw new HTTPException(400, {
      message: "Missing 'redirect_uri' query param",
    });
  }

  return c.json({
    url: buildAuthorizeUrl(redirect_uri, state),
  });
});

// Connect an account (in-app flow). agent_id makes the connection
// USER-SCOPED — the account becomes that member's personal channel instead
// of the org's shared inbox, and any member may connect their own (see
// requireScope). Absent connects the org's, admin+.
app.post(
  "/tiktok-management/signup",
  requireRoles(["member", "admin", "owner"]),
  async (c) => {
    const payload = await c.req.json<TikTokLoginPayload>();
    log.info("TikTok login payload", payload);

    await requireScope(
      c,
      payload.organization_id,
      payload.agent_id,
      requireRoles(["admin", "owner"]),
    );

    // Users may not modify organizations_addresses directly; use the unsecure
    // client now that the role check has passed.
    const client = createUnsecureClient();

    try {
      const address = await performTikTokLogin(client, payload);

      log.info("Signup completed", {
        organization_id: payload.organization_id,
        address: address.address,
      });

      return c.json(address);
    } catch (error) {
      if (error instanceof HTTPException || error instanceof TikTokError) {
        log.error(error.message, error);

        await client
          .from("logs")
          .insert({
            organization_id: payload.organization_id,
            category: "login",
            service: "tiktok",
            level: "error",
            message: error.message,
            metadata: error.cause as Json,
          })
          .throwOnError();
      } else {
        log.error("TikTok login failed", error);
      }

      throw error;
    }
  },
);

// Disconnect an account. A member disconnects their own user-scoped one;
// admin+ any.
app.delete(
  "/tiktok-management/signup",
  requireRoles(["member", "admin", "owner"]),
  async (c) => {
    const payload = await c.req.json<
      { organization_id: string; open_id: string }
    >();
    log.info("TikTok disconnect payload", payload);

    if (
      !await ownsAddress(
        c,
        payload.organization_id,
        "tiktok",
        payload.open_id,
      )
    ) {
      await requireRoles(["admin", "owner"])(c, () => Promise.resolve());
    }

    const client = createUnsecureClient();

    const address = await disconnect(client, payload);

    return c.json(address);
  },
);

// Public onboard routes (token-based, no auth header).

app.get("/tiktok-management/onboard", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    throw new HTTPException(400, { message: "Missing 'token' query param" });
  }

  const client = createUnsecureClient();

  const { data, error } = await client
    .from("onboarding_tokens")
    .select("id, organization_id, organizations(name)")
    .eq("id", token)
    .eq("service", "tiktok")
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !data) {
    return c.json({ valid: false });
  }

  // Whether the organization's connections cap has room for one more, so the
  // page can say so before the customer goes through TikTok's login for
  // nothing. A link stays usable once the cap has room again; the POST checks
  // anew. Optimistic on a failed check: the POST has the final word.
  const can_connect = await canConnect(
    client,
    data.organization_id,
    "tiktok",
    {},
  ).catch((error) => {
    log.warn("Onboard cap check failed", error);
    return true;
  });

  return c.json({
    valid: true,
    organization_name: data.organizations?.name,
    can_connect,
  });
});

app.post("/tiktok-management/onboard", async (c) => {
  const body = await c.req.json<
    { token: string; code: string; redirect_uri: string }
  >();

  if (!body.token) {
    throw new HTTPException(400, { message: "Missing 'token' body param" });
  }

  log.info("Public TikTok onboard payload", body);

  const client = createUnsecureClient();

  // Read the token once and validate it in code — don't consume it; the link is
  // marked used only after the account connects (below). A single read also lets
  // us log exactly why a token was rejected when an onboard link "was used" but
  // nothing happened on our side.
  const { data: tokenData, error: tokenError } = await client
    .from("onboarding_tokens")
    .select("status, service, expires_at, organization_id")
    .eq("id", body.token)
    .maybeSingle();

  const reason = tokenError
    ? `db error: ${tokenError.message}`
    : !tokenData
    ? "token not found"
    : tokenData.service !== "tiktok"
    ? `service mismatch (token is '${tokenData.service}')`
    : tokenData.status !== "active"
    ? `not active (status '${tokenData.status}')`
    : new Date(tokenData.expires_at) <= new Date()
    ? `expired at ${tokenData.expires_at}`
    : null;

  if (reason || !tokenData) {
    log.warn("Onboard token rejected", {
      token: body.token,
      reason,
      organization_id: tokenData?.organization_id,
    });

    throw new HTTPException(400, {
      message: "Invalid or expired onboarding token",
    });
  }

  log.info("Onboard token validated", {
    token: body.token,
    organization_id: tokenData.organization_id,
  });

  const payload: TikTokLoginPayload = {
    code: body.code,
    redirect_uri: body.redirect_uri,
    organization_id: tokenData.organization_id,
    onboarding_token_id: body.token,
  };

  // Connect the account, then mark the link used on success. Same try/catch as
  // the authenticated /signup route: on failure record it (with TikTok's cause)
  // to public.logs so the org's tech-provider can self-debug a bad
  // callback/redirect — not just OpenBSP operators reading stdout. The token
  // stays active on failure, so the customer can retry.
  try {
    const address = await performTikTokLogin(client, payload);

    // Connected — mark the link used. This is the function's authoritative
    // status write, derived from the actual onboarding outcome. The status guard
    // keeps it idempotent under a double submit.
    await client
      .from("onboarding_tokens")
      .update({ status: "used", used_at: new Date().toISOString() })
      .eq("id", body.token)
      .eq("status", "active");

    log.info("Onboard completed", {
      token: body.token,
      organization_id: tokenData.organization_id,
      address: address.address,
    });

    return c.json(address);
  } catch (error) {
    if (error instanceof HTTPException || error instanceof TikTokError) {
      log.error(error.message, error);
      await client
        .from("logs")
        .insert({
          organization_id: tokenData.organization_id,
          category: "login",
          service: "tiktok",
          level: "error",
          message: error.message,
          metadata: error.cause as Json,
        })
        .throwOnError();
    } else {
      log.error("TikTok login failed", error);
    }

    throw error;
  }
});

function requireServiceRole(authorization: string | undefined) {
  if (authorization?.replace("Bearer ", "") !== SERVICE_ROLE_KEY) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
}

// The app's one webhook (service-role key): where TikTok sends every
// authorized account's messages. POST points it at this deployment's
// tiktok-webhook, or at `callback_url` when the functions sit behind another
// host; GET shows where it points.
app.post("/tiktok-management/webhook", async (c) => {
  requireServiceRole(c.req.header("Authorization"));

  const body = await c.req.json<{ callback_url?: string }>().catch(() => ({}));
  const callback_url = (body as { callback_url?: string }).callback_url ??
    `${SUPABASE_URL}/functions/v1/tiktok-webhook`;

  log.info("Pointing the TikTok webhook", { callback_url });

  return Response.json({
    callback_url,
    result: await updateWebhook(callback_url),
  });
});

app.get("/tiktok-management/webhook", async (c) => {
  requireServiceRole(c.req.header("Authorization"));

  return Response.json(await getWebhook());
});

// Token refresh (invoked by the cron with the service-role key).
app.post("/tiktok-management/refresh-tokens", async (c) => {
  requireServiceRole(c.req.header("Authorization"));

  const client = createUnsecureClient();
  const summary = await refreshTokens(client);

  return c.json(summary);
});

Deno.serve(app.fetch);
