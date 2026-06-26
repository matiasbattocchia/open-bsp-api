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
  type TemplateData,
} from "../_shared/supabase.ts";
import {
  createTemplate,
  deleteTemplate,
  editTemplate,
  fetchTemplate,
  listTemplates,
} from "./templates.ts";
import {
  deleteSignup,
  performEmbeddedSignup,
  SignupPayload,
} from "./embedded_signup.ts";
import { type User } from "@supabase/supabase-js";

type TemplatePayload = {
  organization_id: string;
  organization_address: string;
  template?: TemplateData;
};

type AppEnv = {
  Variables: {
    supabase: ReturnType<typeof createClient>;
    user: User;
    token: string;
    apiKey: ApiKeyRow;
  };
};

const app = new Hono<AppEnv>();

// CORS middleware
app.use("*", cors());

// Surface thrown errors (and their `cause`) to the client and logs. Hono's
// default handler only serializes an HTTPException's `message`, discarding the
// `cause` where upstream details (e.g. the Graph API error) live.
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

// Validate user or key (skip for public onboard routes)
app.use("*", async (c, next) => {
  if (c.req.path.endsWith("/onboard")) {
    await next();
    return;
  }

  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    throw new HTTPException(401, {
      message: "Missing authorization token",
    });
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

  return;
});

// Require roles middleware factory
function requireRoles(
  roles: Array<"member" | "admin" | "owner">,
) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const client = c.get("supabase");

    // We must clone the request if we want to read the body in middleware
    // because c.req.json() consumes the stream.
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
        log.error(
          `User ${user.id} not authorized for organization ${organization_id}. Allowed roles: ${
            roles.join(", ")
          }`,
          agentError,
        );

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
      log.error(
        `API key not authorized for organization ${organization_id}. Allowed roles: ${
          roles.join(", ")
        }`,
      );

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

// Templates routes

app.put(
  "/whatsapp-management/templates",
  requireRoles(["member", "admin", "owner"]),
  async (c) => {
    const { organization_id, organization_address, template } = await c.req
      .json<TemplatePayload>();

    const client = c.get("supabase");

    // fetch
    if (template) {
      const templateDetails = await fetchTemplate(
        client,
        organization_id,
        organization_address,
        template,
      );

      return c.json(templateDetails);
    }

    // list
    const templates = await listTemplates(
      client,
      organization_id,
      organization_address,
    );

    return c.json(templates);
  },
);

app.post(
  "/whatsapp-management/templates",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const { organization_id, organization_address, template } = await c.req
      .json<TemplatePayload>();

    const client = c.get("supabase");

    const response = await createTemplate(
      client,
      organization_id,
      organization_address,
      template!,
    );

    return c.json(response);
  },
);

app.patch(
  "/whatsapp-management/templates",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const { organization_id, organization_address, template } = await c.req
      .json<TemplatePayload>();

    const client = c.get("supabase");

    const response = await editTemplate(
      client,
      organization_id,
      organization_address,
      template!,
    );

    return c.json(response);
  },
);

app.delete(
  "/whatsapp-management/templates",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const { organization_id, organization_address, template } = await c.req
      .json<TemplatePayload>();

    const client = c.get("supabase");

    const response = await deleteTemplate(
      client,
      organization_id,
      organization_address,
      template!,
    );

    return c.json(response);
  },
);

// Embedded signup routes

app.post("/whatsapp-management/signup", requireRoles(["owner"]), async (c) => {
  const payload = await c.req.json<SignupPayload>();
  log.info("Embedded signup payload", payload);

  // Once the user has been authorized, use the unsecure client to
  // avoid row-level security.
  // Users are not allowed to modify organizations_addresses table.
  const unsecureClient = createUnsecureClient();

  try {
    const address = await performEmbeddedSignup(unsecureClient, payload);

    log.info("Signup completed", {
      organization_id: payload.organization_id,
      address: address.address,
    });

    return c.json(address);
  } catch (error) {
    if (error instanceof HTTPException) {
      log.error(error.message, error);

      await unsecureClient
        .from("logs")
        .insert({
          organization_id: payload.organization_id,
          category: "signup",
          service: "whatsapp",
          level: "error",
          message: error.message,
          metadata: error.cause as Json,
        })
        .throwOnError();
    } else {
      log.error("Embedded signup failed", error);
    }

    throw error;
  }
});

app.delete(
  "/whatsapp-management/signup",
  requireRoles(["owner"]),
  async (c) => {
    const payload = await c.req.json<{
      phone_number_id: string;
      organization_id: string;
    }>();
    log.info("Embedded signup delete payload", payload);

    // Once the user has been authorized, use the unsecure client to
    // avoid row-level security.
    // Users are not allowed to modify organizations_addresses table.
    const unsecureClient = createUnsecureClient();

    const address = await deleteSignup(
      unsecureClient,
      payload,
    );

    return c.json(address);
  },
);

// Public onboard routes (no auth required, token-based)

app.get("/whatsapp-management/onboard", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    throw new HTTPException(400, { message: "Missing 'token' query param" });
  }

  const client = createUnsecureClient();

  const { data, error } = await client
    .from("onboarding_tokens")
    .select("id, organization_id, organizations(name)")
    .eq("id", token)
    .eq("service", "whatsapp")
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

app.post("/whatsapp-management/onboard", async (c) => {
  const body = await c.req.json<{
    token: string;
    code: string;
    application_id?: string;
    phone_number_id?: string;
    waba_id?: string;
    business_id?: string;
    flow_type?: "only_waba" | "new_phone_number" | "existing_phone_number";
  }>();

  if (!body.token) {
    throw new HTTPException(400, { message: "Missing 'token' body param" });
  }

  log.info("Public onboard payload", body);

  const client = createUnsecureClient();

  // Read the token once and validate it in code — don't consume it; the link is
  // marked used only after the account connects (below). A single read also lets
  // us log exactly why a token was rejected when an onboard link "was used" but
  // nothing happened on our side.
  const { data: tokenData, error: tokenError } = await client
    .from("onboarding_tokens")
    .select(
      "status, service, expires_at, organization_id, callback_url, verify_token",
    )
    .eq("id", body.token)
    .maybeSingle();

  const reason = tokenError
    ? `db error: ${tokenError.message}`
    : !tokenData
    ? "token not found"
    : tokenData.service !== "whatsapp"
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

  const payload: SignupPayload = {
    code: body.code,
    application_id: body.application_id,
    organization_id: tokenData.organization_id,
    phone_number_id: body.phone_number_id,
    waba_id: body.waba_id,
    business_id: body.business_id,
    flow_type: body.flow_type,
    callback_url: tokenData.callback_url ?? undefined,
    verify_token: tokenData.verify_token ?? undefined,
  };

  // Connect the account, then mark the link used on success. Same try/catch as
  // the authenticated /signup route: on failure record it (with the Meta cause)
  // to public.logs so the org's tech-provider can self-debug a bad
  // callback_url/verify_token — not just OpenBSP operators reading stdout. The
  // token stays active on failure, so the customer can retry.
  try {
    const address = await performEmbeddedSignup(client, payload);

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
    if (error instanceof HTTPException) {
      log.error(error.message, error);
      await client
        .from("logs")
        .insert({
          organization_id: tokenData.organization_id,
          category: "signup",
          service: "whatsapp",
          level: "error",
          message: error.message,
          metadata: error.cause as Json,
        })
        .throwOnError();
    } else {
      log.error("Embedded signup failed", error);
    }

    throw error;
  }
});

Deno.serve(app.fetch);
