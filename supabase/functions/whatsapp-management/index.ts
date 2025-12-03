import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import * as log from "../_shared/logger.ts";
import {
  createClient,
  createUnsecureClient,
  type TemplateData,
} from "../_shared/supabase.ts";
import {
  createTemplate,
  deleteTemplate,
  editTemplate,
  fetchTemplates,
  getBusinessCredentials,
} from "./templates.ts";
import {
  deleteSignup,
  performEmbeddedSignup,
  SignupPayload,
} from "./embedded_signup.ts";

const app = new Hono<
  { Variables: { supabase: ReturnType<typeof createClient> } }
>();

// CORS middleware
app.use("*", cors());

// Supabase client middleware
app.use("*", async (c, next) => {
  const client = createClient(c.req.raw);
  c.set("supabase", client);
  await next();
});

// Templates routes

app.get("/whatsapp-management/templates", async (c) => {
  const { organization_address } = await c.req.json<{
    organization_address: string;
  }>();

  const client = c.get("supabase");

  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_address,
  );

  const templates = await fetchTemplates(waba_id, access_token);

  return c.json(templates);
});

app.post("/whatsapp-management/templates", async (c) => {
  const { organization_address, template } = await c.req.json<{
    organization_address: string;
    template: TemplateData;
  }>();

  const client = c.get("supabase");

  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_address,
  );

  const response = await createTemplate(waba_id, access_token, template);

  return c.json(response);
});

app.patch("/whatsapp-management/templates", async (c) => {
  const { organization_address, template } = await c.req.json<{
    organization_address: string;
    template: TemplateData;
  }>();

  const client = c.get("supabase");

  const { access_token } = await getBusinessCredentials(
    client,
    organization_address,
  );

  const response = await editTemplate(access_token, template);

  return c.json(response);
});

app.delete("/whatsapp-management/templates", async (c) => {
  const { organization_address, template } = await c.req.json<{
    organization_address: string;
    template: TemplateData;
  }>();

  const client = c.get("supabase");

  const { waba_id, access_token } = await getBusinessCredentials(
    client,
    organization_address,
  );

  const response = await deleteTemplate(waba_id, access_token, template);

  return c.json(response);
});

// Embedded signup routes

app.post("/whatsapp-management/signup", async (c) => {
  const client = c.get("supabase");

  const payload = await c.req.json<SignupPayload>();
  log.info("Embedded signup payload", payload);

  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser();

  if (userError || !user) {
    log.error("Missing or invalid Authorization header", userError);
    throw new HTTPException(401, {
      message: "Missing or invalid Authorization header",
      cause: userError,
    });
  }

  const { error: agentError } = await client
    .from("agents")
    .select()
    .eq("organization_id", payload.organization_id)
    .eq("user_id", user.id)
    .single();

  if (agentError) {
    log.error(
      `User ${user.id} not authorized for organization ${payload.organization_id}`,
      agentError,
    );
    throw new HTTPException(403, {
      message:
        `User ${user.id} not authorized for organization ${payload.organization_id}`,
      cause: agentError,
    });
  }

  // Once the user has been authorized, use the unsecure client to
  // avoid row-level security.
  // Users are not allowed to modify organizations_addresses table.
  const unsecureClient = createUnsecureClient();

  try {
    const address = await performEmbeddedSignup(unsecureClient, payload);

    return c.json(address);
  } catch (error) {
    if (error instanceof HTTPException) {
      log.error(error.message, error);

      await client
        .from("logs")
        .insert({
          category: "signup",
          level: "error",
          message: error.message,
          metadata: error,
        })
        .throwOnError();
    } else {
      log.error("Embedded signup failed", error);
    }

    throw error;
  }
});

app.delete("/whatsapp-management/signup", async (c) => {
  const client = c.get("supabase");

  const payload = await c.req.json<{
    phone_number_id: string;
    organization_id: string;
  }>();
  log.info("Embedded signup delete payload", payload);

  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser();

  if (userError || !user) {
    log.error("Missing or invalid Authorization header", userError);
    throw new HTTPException(401, {
      message: "Missing or invalid Authorization header",
      cause: userError,
    });
  }

  const { error: agentError } = await client
    .from("agents")
    .select()
    .eq("organization_id", payload.organization_id)
    .eq("user_id", user.id)
    .single();

  if (agentError) {
    log.error(
      `User ${user.id} not authorized for organization ${payload.organization_id}`,
      agentError,
    );
    throw new HTTPException(403, {
      message:
        `User ${user.id} not authorized for organization ${payload.organization_id}`,
      cause: agentError,
    });
  }

  // Once the user has been authorized, use the unsecure client to
  // avoid row-level security.
  // Users are not allowed to modify organizations_addresses table.
  const unsecureClient = createUnsecureClient();

  const address = await deleteSignup(
    unsecureClient,
    payload,
  );

  return c.json(address);
});

Deno.serve(app.fetch);
