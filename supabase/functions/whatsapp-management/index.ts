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
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTemplate,
  deleteTemplate,
  editTemplate,
  fetchTemplates,
  getBusinessCredentials,
} from "./templates.ts";
import { performEmbeddedSignup, SignupPayload } from "./embedded_signup.ts";
import { decodeBase64Url } from "@std/encoding/base64url";

const app = new Hono<{ Variables: { supabase: SupabaseClient } }>();

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

  const client = c.get("supabase") as SupabaseClient;

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

  const client = c.get("supabase") as SupabaseClient;

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

  const client = c.get("supabase") as SupabaseClient;

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

  const client = c.get("supabase") as SupabaseClient;

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

  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    throw new HTTPException(401, {
      message: "Missing or invalid Authorization header",
    });
  }

  const jwt = authHeader.replace("Bearer ", "");
  const parts = jwt.split(".");

  if (parts.length !== 3) {
    throw new HTTPException(401, { message: "Invalid JWT format" });
  }

  let claims: { sub?: string };

  try {
    const base64decodedPart = decodeBase64Url(parts[1]);
    const decodedPayload = new TextDecoder().decode(base64decodedPart);
    claims = JSON.parse(decodedPayload);
  } catch (error) {
    throw new HTTPException(401, { message: "Invalid JWT", cause: error });
  }

  if (!claims?.sub) {
    throw new HTTPException(401, { message: "Missing sub claim" });
  }

  const { error: agentError } = await client
    .from("agents")
    .select()
    .eq("organization_id", payload.organization_id)
    .eq("user_id", claims.sub)
    .single();

  if (agentError) {
    throw new HTTPException(403, {
      message: "User not authorized for this organization",
      cause: agentError,
    });
  }

  // Once the user has been authorized, use the unsecure client to
  // avoid row-level security
  const unsecureClient = createUnsecureClient();

  const address = await performEmbeddedSignup(unsecureClient, payload);

  return c.json(address);
});

Deno.serve(app.fetch);
