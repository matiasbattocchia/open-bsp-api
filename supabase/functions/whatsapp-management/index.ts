import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import * as log from "../_shared/logger.ts";
import { createClient, type TemplateData } from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTemplate,
  deleteTemplate,
  editTemplate,
  fetchTemplates,
  getBusinessCredentials,
} from "./templates.ts";
import { performEmbeddedSignup } from "./embedded_signup.ts";

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

  const { data } = await client.auth.getUser();

  if (!data.user) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  const payload = await c.req.json();
  log.info("Embedded signup payload", payload);

  const address = await performEmbeddedSignup(client, payload);

  return c.json(address);
});

Deno.serve(app.fetch);
