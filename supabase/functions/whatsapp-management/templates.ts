import type { TemplateData } from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";

const API_VERSION = "v24.0";

export async function getBusinessCredentials(
  client: SupabaseClient,
  organization_address: string,
): Promise<{ waba_id: string; access_token: string }> {
  const { data, error } = await client
    .from("organizations_addresses")
    .select("extra->>waba_id, extra->>access_token")
    .eq("address", organization_address)
    .single();

  if (error) {
    log.error("Could not fetch business access token", error);
    throw new HTTPException(403, {
      message: "Could not fetch business access token",
      cause: error,
    });
  }

  return data;
}

export async function fetchTemplates(
  waba_id: string,
  access_token: string,
): Promise<TemplateData[]> {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!response.ok) {
    const errorCause = {
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.json().catch(() => ({})),
    };
    log.error("Could not fetch templates", errorCause);
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not fetch templates",
      cause: errorCause,
    });
  }

  return await response.json();
}

export async function createTemplate(
  waba_id: string,
  access_token: string,
  template: TemplateData,
): Promise<{
  id: string;
  status: string;
  category: string;
}> {
  const { name, category, language, components } = template;
  const filteredTemplate = {
    name,
    category,
    allow_category_change: true,
    language,
    components,
  };

  console.log(filteredTemplate);

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(filteredTemplate),
    },
  );

  if (!response.ok) {
    const errorCause = {
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.json().catch(() => ({})),
    };
    log.error("Could not create template", errorCause);
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not create template",
      cause: errorCause,
    });
  }

  return await response.json();
}

export async function editTemplate(
  access_token: string,
  template: TemplateData,
): Promise<{
  success: boolean;
}> {
  const { category, components } = template;
  const filteredTemplate = { category, components };

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${template.id}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(filteredTemplate),
    },
  );

  if (!response.ok) {
    const errorCause = {
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.json().catch(() => ({})),
    };
    log.error("Could not update template", errorCause);
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not update template",
      cause: errorCause,
    });
  }

  return await response.json();
}

export async function deleteTemplate(
  waba_id: string,
  access_token: string,
  template: TemplateData,
): Promise<{
  success: boolean;
}> {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates?name=${template.name}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    },
  );

  if (!response.ok) {
    const errorCause = {
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.json().catch(() => ({})),
    };
    log.error("Could not delete template", errorCause);
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not delete template",
      cause: errorCause,
    });
  }

  return await response.json();
}
