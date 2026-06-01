import type { Database } from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";

const API_VERSION = "v24.0";

async function getCredentials(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
): Promise<{ access_token: string }> {
  const { getSecret } = await import("../_shared/secrets.ts");
  const access_token = await getSecret(client, organization_id, organization_address, "access_token") || "";

  if (!access_token) {
    throw new HTTPException(403, { message: "Access token not configured" });
  }

  return { access_token };
}

async function metaFetch(
  url: string,
  access_token: string,
  options: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    const detail = data?.error?.message || response.statusText;
    log.error("Meta API error", { url, status: response.status, detail });
    throw new HTTPException(response.status as 400, { message: detail });
  }

  return data;
}

export async function listGroups(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  limit = 100,
) {
  const { access_token } = await getCredentials(client, organization_id, organization_address);

  return await metaFetch(
    `https://graph.facebook.com/${API_VERSION}/${organization_address}/groups?limit=${limit}`,
    access_token,
  );
}

export async function createGroup(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  subject: string,
  description?: string,
) {
  const { access_token } = await getCredentials(client, organization_id, organization_address);

  return await metaFetch(
    `https://graph.facebook.com/${API_VERSION}/${organization_address}/groups`,
    access_token,
    {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        subject,
        ...(description && { description }),
      }),
    },
  );
}

export async function deleteGroup(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  group_id: string,
) {
  const { access_token } = await getCredentials(client, organization_id, organization_address);

  return await metaFetch(
    `https://graph.facebook.com/${API_VERSION}/${group_id}`,
    access_token,
    { method: "DELETE" },
  );
}

export async function getGroupInviteLink(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  group_id: string,
) {
  const { access_token } = await getCredentials(client, organization_id, organization_address);

  return await metaFetch(
    `https://graph.facebook.com/${API_VERSION}/${group_id}/invite_link`,
    access_token,
  );
}

export async function listJoinRequests(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  group_id: string,
) {
  const { access_token } = await getCredentials(client, organization_id, organization_address);

  return await metaFetch(
    `https://graph.facebook.com/${API_VERSION}/${group_id}/join_requests`,
    access_token,
  );
}

export async function approveJoinRequests(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  group_id: string,
  join_requests: string[],
) {
  const { access_token } = await getCredentials(client, organization_id, organization_address);

  return await metaFetch(
    `https://graph.facebook.com/${API_VERSION}/${group_id}/join_requests`,
    access_token,
    {
      method: "POST",
      body: JSON.stringify({ messaging_product: "whatsapp", join_requests }),
    },
  );
}

export async function rejectJoinRequests(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  group_id: string,
  join_requests: string[],
) {
  const { access_token } = await getCredentials(client, organization_id, organization_address);

  return await metaFetch(
    `https://graph.facebook.com/${API_VERSION}/${group_id}/join_requests`,
    access_token,
    {
      method: "DELETE",
      body: JSON.stringify({ messaging_product: "whatsapp", join_requests }),
    },
  );
}

/**
 * Send a group invite link template message to a contact.
 * Uses the Meta "Group invite link" template type.
 * See: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/get-started
 */
export async function sendGroupInvite(
  client: SupabaseClient<Database>,
  organization_id: string,
  organization_address: string,
  group_id: string,
  invite_link: string,
  recipient_phone: string,
  template_name: string,
  language_code = "en",
) {
  const { access_token } = await getCredentials(client, organization_id, organization_address);

  return await metaFetch(
    `https://graph.facebook.com/${API_VERSION}/${organization_address}/messages`,
    access_token,
    {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient_phone,
        type: "template",
        template: {
          name: template_name,
          language: { code: language_code },
          components: [
            {
              type: "button",
              sub_type: "group_invite",
              index: "0",
              parameters: [
                {
                  type: "group_invite",
                  group_invite: {
                    group_id,
                    invite_link,
                  },
                },
              ],
            },
          ],
        },
      }),
    },
  );
}
