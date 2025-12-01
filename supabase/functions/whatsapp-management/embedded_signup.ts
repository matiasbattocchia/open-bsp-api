import * as log from "../_shared/logger.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import type { createClient } from "../_shared/supabase.ts";
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";

const API_VERSION = "v24.0";
const APP_ID = Deno.env.get("META_APP_ID");
const APP_SECRET = Deno.env.get("META_APP_SECRET");

// Step 1
async function getBusinessAccessToken(
  app_id: string,
  app_secret: string,
  code: string,
): Promise<string> {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/oauth/access_token?client_id=${app_id}&client_secret=${app_secret}&code=${code}`,
  );

  if (!response.ok) {
    const errorCause = {
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.json().catch(() => ({})),
    };
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not get business access token",
      cause: errorCause,
    });
  }

  return (await response.json()).access_token;
}

/** Sample response
{
  "data" : {
    "app_id" : "670843887433847",
    "application" : "JaspersMarket",
    "data_access_expires_at" : 1672092840,
    "expires_at" : 1665090000,
    "granular_scopes" : [
      {
        "scope" : "whatsapp_business_management",
        "target_ids" : [
          "102289599326934", // ID of newest WABA to grant app whatsapp_business_management
          "101569239400667"
        ]
      },
      {
        "scope" : "whatsapp_business_messaging",
        "target_ids" : [
          "102289599326934",
          "101569239400667"
        ]
      }
    ],
    "is_valid" : true,
    "scopes" : [
       "whatsapp_business_management",
       "whatsapp_business_messaging",
       "public_profile"
    ],
    "type" : "USER",
    "user_id" : "10222270944537964"
  }
}

export async function getWabaId(
  business_access_token: string,
): Promise<string> {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/debug_token?input_token=${business_access_token}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return (await response.json()).data.granular_scopes.find(
    (scope: { scope: string; target_ids: string[] }) =>
      scope.scope === "whatsapp_business_management",
  ).target_ids[0];
}
*/

/** Sample response
{
  "data": [
    {
      "verified_name": "Jasper's Market",
      "display_phone_number": "+1 631-555-5555",
      "id": "1906385232743451",
      "quality_rating": "GREEN"

    },
    {
      "verified_name": "Jasper's Ice Cream",
      "display_phone_number": "+1 631-555-5556",
      "id": "1913623884432103",
      "quality_rating": "NA"
    }
  ]
}

export async function getPhoneNumberId(
  business_access_token: string,
  waba_id: string,
): Promise<{
  verified_name: string;
  display_phone_number: string;
  id: string;
  quality_rating: string;
}> {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/phone_numbers?access_token=${business_access_token}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return (await response.json()).data[0];
}
*/

// Step 2
async function postSubscribeToWebhooks(
  business_access_token: string,
  waba_id: string,
): Promise<boolean> {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/subscribed_apps`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${business_access_token}`,
      },
    },
  );

  if (!response.ok) {
    const errorCause = {
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.json().catch(() => ({})),
    };
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not subscribe to webhooks",
      cause: errorCause,
    });
  }

  return (await response.json()).success;
}

// Step 3
async function postRegisterPhoneNumber(
  business_access_token: string,
  phone_number_id: string,
  pin: string,
): Promise<boolean> {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phone_number_id}/register`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${business_access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        pin,
      }),
    },
  );

  if (!response.ok) {
    const errorCause = {
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.json().catch(() => ({})),
    };
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not register phone number",
      cause: errorCause,
    });
  }

  return (await response.json()).success;
}

/*
export async function postAddSystemUserToWaba(waba_id: string) {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${waba_id}/assigned_users?user=${system_user_id}&tasks=['MANAGE']&access_token=${access_token}`,
    {
      method: "POST",
    },
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return (await response.json()).success;
}
*/

async function getPhoneNumber(
  business_access_token: string,
  phone_number_id: string,
): Promise<{
  code_verification_status: string;
  display_phone_number: string;
  id: string;
  quality_rating: string;
  verified_name: string;
}> {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phone_number_id}`,
    {
      headers: { Authorization: `Bearer ${business_access_token}` },
    },
  );

  if (!response.ok) {
    const errorCause = {
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.json().catch(() => ({})),
    };
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not get phone number data",
      cause: errorCause,
    });
  }

  return await response.json();
}

async function postInitDataSync(
  business_access_token: string,
  phone_number_id: string,
  type: "contacts" | "messages",
): Promise<{
  messaging_product: "whatsapp";
  request_id: string;
}> {
  log.info(`Initiating app data sync for ${phone_number_id} ${type}`);

  const syncTypeMap = {
    contacts: "smb_app_state_sync",
    messages: "history",
  };

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phone_number_id}/smb_app_data`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${business_access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        sync_type: syncTypeMap[type],
      }),
    },
  );

  if (!response.ok) {
    const errorCause = {
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.json().catch(() => ({})),
    };
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: `Could not initiate ${type} app data synchronization`,
      cause: errorCause,
    });
  }

  return await response.json();
}

export type SignupPayload = {
  code: string;
  application_id?: string;
  organization_id: string;
  phone_number_id?: string;
  waba_id?: string;
  business_id?: string;
  flow_type?: "only_waba" | "new_phone_number" | "existing_phone_number";
};

export async function performEmbeddedSignup(
  client: ReturnType<typeof createClient>,
  payload: SignupPayload,
) {
  if (!payload.code) {
    throw new HTTPException(400, { message: "Missing 'code' body param!" });
  }

  if (!payload.organization_id) {
    throw new HTTPException(400, {
      message: "Missing 'organization_id' body param!",
    });
  }

  if (!payload.waba_id) {
    throw new HTTPException(400, {
      message: "Missing 'waba_id' body param!",
    });
  }

  if (!payload.phone_number_id) {
    throw new HTTPException(400, {
      message: "Missing 'phone_number_id' body param!",
    });
  }

  if (!APP_ID || !APP_SECRET) {
    throw new HTTPException(401, {
      message: "META_APP_ID or META_APP_SECRET environment variable not set",
    });
  }

  const ids = APP_ID.split("|");
  const secrets = APP_SECRET.split("|");

  if (ids.length !== secrets.length) {
    throw new HTTPException(500, {
      message:
        "META_APP_ID and META_APP_SECRET environment variables must have the same number of elements, separated by '|'",
    });
  }

  let idIndex = 0;

  if (payload.application_id) {
    idIndex = ids.indexOf(payload.application_id);

    if (idIndex === -1) {
      throw new HTTPException(500, {
        message:
          `Could not find application id '${payload.application_id}' in META_APP_ID environment variable`,
      });
    }
  }

  const app_id = ids[idIndex];
  const app_secret = secrets[idIndex];

  log.info("Step 1: Exchange the token code for a business token");
  const business_access_token = await getBusinessAccessToken(
    app_id,
    app_secret,
    payload.code,
  );

  log.info("Step 2: Subscribe to webhooks on the customer's WABA");
  await postSubscribeToWebhooks(business_access_token, payload.waba_id);

  if (payload.flow_type === "existing_phone_number") {
    log.info("Coexistence flow: Skipping step 3");
  } else {
    log.info("Step 3: Register the customer's phone number");
    const pin = "123456";
    await postRegisterPhoneNumber(
      business_access_token,
      payload.phone_number_id,
      pin,
    );
  }

  log.info("Getting phone number data");
  const phone_number = await getPhoneNumber(
    business_access_token,
    payload.phone_number_id,
  );

  log.info("Persisting phone number data");
  const { data, error } = await client
    .from("organizations_addresses")
    .upsert({
      service: "whatsapp",
      address: payload.phone_number_id,
      organization_id: payload.organization_id,
      status: "connected",
      extra: {
        waba_id: payload.waba_id,
        access_token: business_access_token,
        phone_number: phone_number.display_phone_number,
        verified_name: phone_number.verified_name,
      },
    })
    .select()
    .single();

  if (error) {
    throw new HTTPException(500, {
      message: "Could not persist phone number data",
      cause: error,
    });
  }

  // App data sync is a coexistence only feature
  if (payload.flow_type === "existing_phone_number") {
    log.info("Step 4: Initiating contacts sync");
    await postInitDataSync(
      business_access_token,
      payload.phone_number_id,
      "contacts",
    );

    log.info("Step 5: Initiating messages sync");
    await postInitDataSync(
      business_access_token,
      payload.phone_number_id,
      "messages",
    );
  }

  return data;
}

async function deregisterPhoneNumber(
  business_access_token: string,
  phone_number_id: string,
): Promise<boolean> {
  log.info(`Deregistering phone number: ${phone_number_id}`);

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phone_number_id}/deregister`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${business_access_token}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    const errorCause = {
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.json().catch(() => ({})),
    };
    log.error("Could not deregister phone number", errorCause);
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not deregister phone number",
      cause: errorCause,
    });
  }

  return (await response.json()).success;
}

export async function deleteSignup(
  client: ReturnType<typeof createClient>,
  payload: { phone_number_id: string },
) {
  const { phone_number_id } = payload;

  const { data: organization_address } = await client
    .from("organizations_addresses")
    .select()
    .eq("address", phone_number_id)
    .single()
    .throwOnError();

  const extra = organization_address.extra || {};

  if (extra.flow_type !== "new_phone_number") {
    throw new HTTPException(403, {
      message:
        "Cannot deregister organization address. Only new phone numbers can be deregistered.",
    });
  }

  await deregisterPhoneNumber(extra.access_token || "", phone_number_id);

  const { data } = await client
    .from("organizations_addresses")
    .update({
      status: "disconnected",
    })
    .eq("address", phone_number_id)
    .select()
    .single()
    .throwOnError();

  return data;
}
