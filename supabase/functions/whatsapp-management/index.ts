import * as log from "../_shared/logger.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { createClient, type TemplateData } from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const api_version = "v21.0";
const app_id = Deno.env.get("META_APP_ID");
//log.info("APP ID", app_id);
const app_secret = Deno.env.get("META_APP_SECRET");
//log.info("APP SECRET", app_secret);
const system_user_id = Deno.env.get("META_SYSTEM_USER_ID");
//log.info("SYSTEM USER ID", system_user_id);
const access_token = Deno.env.get("META_SYSTEM_USER_ACCESS_TOKEN");
//log.info("ACCESS TOKEN", access_token);

async function getBusinessIntegrationSystemUserAccessToken(
  code: string
): Promise<string> {
  const response = await fetch(
    `https://graph.facebook.com/${api_version}/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: app_id,
        client_secret: app_secret,
        code,
        grant_type: "authorization_code",
      }),
    }
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
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
 */
async function getWabaId(business_access_token: string): Promise<string> {
  const response = await fetch(
    `https://graph.facebook.com/${api_version}/debug_token?input_token=${business_access_token}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    }
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return (await response.json()).data.granular_scopes.find(
    (scope: { scope: string; target_ids: string[] }) =>
      scope.scope === "whatsapp_business_management"
  ).target_ids[0];
}

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
 */
async function getPhoneNumberId(
  business_access_token: string,
  waba_id: string
): Promise<{
  verified_name: string;
  display_phone_number: string;
  id: string;
  quality_rating: string;
}> {
  const response = await fetch(
    `https://graph.facebook.com/${api_version}/${waba_id}/phone_numbers?access_token=${business_access_token}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    }
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return (await response.json()).data[0];
}

async function postRegisterBusinessPhoneNumber(
  business_access_token: string,
  phone_number_id: string
): Promise<string> {
  const response = await fetch(
    `https://graph.facebook.com/${api_version}/${phone_number_id}/register`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${business_access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        pin: "000000",
      }),
    }
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return (await response.json()).success;
}

async function postSubscribeToWaba(
  business_access_token: string,
  waba_id: string
): Promise<boolean> {
  const response = await fetch(
    `https://graph.facebook.com/${api_version}/${waba_id}/subscribed_apps`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${business_access_token}`,
      },
    }
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return (await response.json()).success;
}

async function postAddSystemUserToWaba(waba_id: string) {
  const response = await fetch(
    `https://graph.facebook.com/${api_version}/${waba_id}/assigned_users?user=${system_user_id}&tasks=['MANAGE']&access_token=${access_token}`,
    {
      method: "POST",
    }
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return (await response.json()).success;
}

async function getBusinessCredentials(
  client: SupabaseClient,
  organization_address: string
) {
  const { data, error } = await client
    .from("organizations_addresses")
    .select("extra->>waba_id, extra->>access_token")
    .eq("address", organization_address)
    .limit(1)
    .single();

  if (error) {
    throw error;
  }

  /* Throw
  if (!data.access_token || !data.waba_id) {
    return new Response(
      "Missing WABA ID and/or access token. Check organization address 'extra' field.",
      {
        headers: corsHeaders,
        status: 401,
      }
    );
  }
  */

  return data;
}

async function fetchTemplates(
  waba_id: string,
  access_token: string
): Promise<TemplateData[]> {
  const response = await fetch(
    `https://graph.facebook.com/${api_version}/${waba_id}/message_templates`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${access_token}` },
    }
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return await response.json();
}

async function createTemplate(
  waba_id: string,
  access_token: string,
  template: TemplateData
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
    `https://graph.facebook.com/${api_version}/${waba_id}/message_templates`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(filteredTemplate),
    }
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return await response.json();
}

async function editTemplate(
  access_token: string,
  template: TemplateData
): Promise<{
  success: boolean;
}> {
  const { category, components } = template;
  const filteredTemplate = { category, components };

  const response = await fetch(
    `https://graph.facebook.com/${api_version}/${template.id}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(filteredTemplate),
    }
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return await response.json();
}

async function deleteTemplate(
  waba_id: string,
  access_token: string,
  template: TemplateData
): Promise<{
  success: boolean;
}> {
  const response = await fetch(
    `https://graph.facebook.com/${api_version}/${waba_id}/message_templates?name=${template.name}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    }
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return await response.json();
}

/*
curl -X POST http://127.0.0.1:54321/functions/v1/whatsapp-management \
  -H "Content-Type: application/json" \
  -d '{
    "code": "AQBAnHN87K2d7j52ADj8q4t9l5fQHzbgsxoSnRNC7cKMz54p0mBGem4Yk1FfNuhOQsqwTnfz0ofRb88SYwOqB4fLp_t9BIlHtCJPufXB12iZWFvU_ZXXOfoM52FiiXg_p7-gnn06XUbzsEn51Akytv88bswXRpJblfamxSJosTrVmRqIMSkYiQbRzfQ9FjevSlLTI0oyhkKLNawxOh-M8zpFgJbnuKH4VtPlm02YlG90hLieF3zApSu1UmBsHwElO6kyxvrSf6r7OlWVdNLzUy9N8aiEc_WbTL8oDxlo3N0-UhAY_DTeqZd58FaWqLOOMGPIjgrPTsYbAxi7btdkHnjjbV0KIlIuOTsMwUwlilbxsi7gs75OlC9S2OjoOnlmPkM",
    "organization_id": "9d8d11a0-2c81-41e0-b457-ada5c25908d7"
  }'
*/

Deno.serve(async (req) => {
  const client = createClient(req);
  // TODO: check that organization_id belongs to the signed in user (check JWT token) - cabra 01/10/24

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const pathname = new URL(req.url).pathname;

  if (pathname === "/whatsapp-management/templates") {
    console.log(`${req.method} /whatsapp-management/templates`);

    const { organization_address, template } = await req.json();

    const { waba_id, access_token } = await getBusinessCredentials(
      client,
      organization_address
    );

    if (req.method === "PUT") {
      // TODO: GET is not working (Supabase JS client bug?). PUT is a workaround.
      const templates = await fetchTemplates(waba_id, access_token);
      return Response.json(templates, { headers: corsHeaders });
    } else if (req.method === "POST") {
      const response = await createTemplate(waba_id, access_token, template);
      return Response.json(response, { headers: corsHeaders });
    } else if (req.method === "PATCH") {
      const response = await editTemplate(access_token, template);
      return Response.json(response, { headers: corsHeaders });
    } else if (req.method === "DELETE") {
      const response = await deleteTemplate(waba_id, access_token, template);
      return Response.json(response, { headers: corsHeaders });
    }
  }

  const { code, organization_id } = await req.json();

  log.info("CODE", code);

  // Step 0: Exchange embedded signup flow code for a business integration system user access token
  log.info(
    "Step 0: Exchange embedded signup flow code for a business integration system user access token"
  );
  const business_access_token =
    await getBusinessIntegrationSystemUserAccessToken(code);
  //log.info("BUSINESS ACCESS TOKEN", business_access_token);
  // Step 1: Get WABA ID
  log.info("Step 1: Get WABA ID");
  const waba_id = await getWabaId(business_access_token);
  log.info("WABA ID", waba_id);
  // Step 2: Get phone number ID
  log.info("Step 2: Get phone number ID");
  const phone_number = await getPhoneNumberId(business_access_token, waba_id);
  log.info("PHONE NUMBER", phone_number);

  // Store phone number data
  log.info("Store phone number data");
  const { error } = await client.from("organizations_addresses").insert({
    service: "whatsapp",
    address: phone_number.id,
    organization_id,
    extra: {
      waba_id,
      access_token: business_access_token,
      phone_number: phone_number.display_phone_number,
      verified_name: phone_number.verified_name,
    },
  });

  if (error) {
    throw error;
  }

  // Step 3: Register phone number
  log.info("Step 3: Register phone number");
  await postRegisterBusinessPhoneNumber(business_access_token, phone_number.id);
  // Step 4: Subscribing for webhook notifications
  log.info("Step 4: Subscribing for webhook notifications");
  await postSubscribeToWaba(business_access_token, waba_id);
  // Step 5: Attaching system user to WABA
  log.info("Step 5: Attaching system user to WABA");
  await postAddSystemUserToWaba(waba_id);
  // Step 6: Attaching payment method to WABA
  // manual step

  log.info("Done");

  return new Response("ok", { headers: corsHeaders });
});
