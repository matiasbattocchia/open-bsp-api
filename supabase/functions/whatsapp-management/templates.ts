import type { Database, TemplateData } from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import { ContentfulStatusCode } from "jsr:@hono/hono/utils/http-status";

const API_VERSION = "v24.0";

async function getBusinessCredentials(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
): Promise<{ waba_id: string; access_token: string }> {
  const { data, error } = await client
    .from("organizations_addresses")
    .select("extra->>waba_id")
    .eq("organization_id", organization_id)
    .eq("address", organization_address)
    .single();

  if (error || !data) {
    log.error("Could not fetch business credentials", error);
    throw new HTTPException(403, {
      message: "Could not fetch business credentials",
      cause: error,
    });
  }

  // Read access token from secure storage
  const { getSecret } = await import("../_shared/secrets.ts");
  const access_token = await getSecret(client, organization_id, organization_address, "access_token") || "";

  return { waba_id: data.waba_id, access_token };
}

export async function listTemplates(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
): Promise<TemplateData[]> {
  const { waba_id, access_token } = await getBusinessCredentials(client, organization_id, organization_address);

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/message_templates`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const detail = error?.error?.message || JSON.stringify(error);
    log.error("Could not fetch templates", error);
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: `Could not fetch templates: ${detail}`,
      cause: error,
    });
  }

  return await response.json();
}

export async function fetchTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<TemplateData> {
  const { access_token } = await getBusinessCredentials(client, organization_id, organization_address);

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${template.id}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const detail = error?.error?.message || JSON.stringify(error);
    log.error("Could not fetch template", error);
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: `Could not fetch template: ${detail}`,
      cause: error,
    });
  }

  return await response.json();
}

export async function createTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  id: string;
  status: string;
  category: string;
}> {
  const { waba_id, access_token } = await getBusinessCredentials(client, organization_id, organization_address);

  const { name, category, language, components } = template;

  const filteredTemplate = {
    name,
    category,
    allow_category_change: true,
    language,
    components,
  };

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
    const error = await response.json().catch(() => ({}));
    const metaError = error?.error || {};
    const detail = [metaError.message, metaError.error_data?.details, metaError.error_user_msg].filter(Boolean).join(" — ") || JSON.stringify(error);
    log.error("Could not create template", error);
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: `Could not create template: ${detail}`,
      cause: error,
    });
  }

  return await response.json();
}

export async function editTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  success: boolean;
}> {
  const { access_token } = await getBusinessCredentials(client, organization_id, organization_address);

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
    const error = await response.json().catch(() => ({}));
    const detail = error?.error?.message || JSON.stringify(error);
    log.error("Could not update template", error);
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: `Could not update template: ${detail}`,
      cause: error,
    });
  }

  return await response.json();
}

export async function deleteTemplate(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  template: TemplateData,
): Promise<{
  success: boolean;
}> {
  const { waba_id, access_token } = await getBusinessCredentials(client, organization_id, organization_address);

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
    const error = await response.json().catch(() => ({}));
    const detail = error?.error?.message || JSON.stringify(error);
    log.error("Could not delete template", error);
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: `Could not delete template: ${detail}`,
      cause: error,
    });
  }

  return await response.json();
}
