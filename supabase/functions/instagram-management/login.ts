import * as log from "../_shared/logger.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import { ContentfulStatusCode } from "jsr:@hono/hono/utils/http-status";
import { decodeBase64Url } from "@std/encoding/base64url";
import type {
  createClient,
  InstagramOrganizationAddressExtra,
} from "../_shared/supabase.ts";

const API_VERSION = "v25.0";
// Instagram Business Login uses the Instagram app's own ID/secret, which differ
// from the Facebook app credentials (META_APP_*). They also sign the deauthorize
// / data-deletion signed_request callbacks.
const APP_ID = Deno.env.get("INSTAGRAM_APP_ID");
const APP_SECRET = Deno.env.get("INSTAGRAM_APP_SECRET");

// Messaging webhook fields we subscribe each connected account to. Comments /
// content publishing are intentionally left out for now.
const SUBSCRIBED_FIELDS = [
  "messages",
  "messaging_postbacks",
  "messaging_seen",
  "message_reactions",
  "messaging_referral",
].join(",");

// OAuth scopes requested during Instagram Business Login.
export const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
];

// Refresh long-lived tokens once they are within this window of expiring.
const REFRESH_WINDOW_MS = 10 * 24 * 60 * 60 * 1000; // 10 days

type Client = ReturnType<typeof createClient>;

/**
 * Resolves the Instagram app credentials, mirroring whatsapp-management: a
 * single Meta app is the common case, but `META_APP_ID`/`META_APP_SECRET` may
 * hold several pipe-separated values for multi-app setups.
 */
function resolveAppCredentials(
  application_id?: string,
): { app_id: string; app_secret: string } {
  if (!APP_ID || !APP_SECRET) {
    throw new HTTPException(401, {
      message:
        "INSTAGRAM_APP_ID or INSTAGRAM_APP_SECRET environment variable not set",
    });
  }

  const ids = APP_ID.split("|");
  const secrets = APP_SECRET.split("|");

  if (ids.length !== secrets.length) {
    throw new HTTPException(500, {
      message:
        "INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET environment variables must have the same number of elements, separated by '|'",
    });
  }

  let idIndex = 0;

  if (application_id) {
    idIndex = ids.indexOf(application_id);

    if (idIndex === -1) {
      throw new HTTPException(500, {
        message:
          `Could not find application id '${application_id}' in INSTAGRAM_APP_ID environment variable`,
      });
    }
  }

  return { app_id: ids[idIndex], app_secret: secrets[idIndex] };
}

type ShortLivedToken = {
  access_token: string;
  user_id: string | number;
  permissions?: string[] | string;
};

// Step 1: exchange the authorization code for a short-lived token.
async function exchangeCodeForShortLivedToken(
  app_id: string,
  app_secret: string,
  code: string,
  redirect_uri: string,
): Promise<ShortLivedToken> {
  const response = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app_id,
      client_secret: app_secret,
      grant_type: "authorization_code",
      redirect_uri,
      code,
    }),
  });

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not exchange code for a short-lived token",
      cause: await response.json().catch(() => ({})),
    });
  }

  // Instagram returns either the flat `{ access_token, user_id, permissions }`
  // or a wrapped `{ data: [{ ... }] }`. Normalize both.
  const raw = (await response.json()) as
    & { data?: ShortLivedToken[] }
    & Partial<ShortLivedToken>;

  const entry = raw.data?.[0];
  const access_token = entry?.access_token ?? raw.access_token;
  const user_id = entry?.user_id ?? raw.user_id;
  const permissions = entry?.permissions ?? raw.permissions;

  if (!access_token || user_id === undefined) {
    throw new HTTPException(502, {
      message: "Unexpected short-lived token exchange response",
      cause: raw,
    });
  }

  return { access_token, user_id, permissions };
}

type LongLivedToken = {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds (~60 days)
};

// Step 2: exchange the short-lived token for a 60-day long-lived token.
async function exchangeForLongLivedToken(
  app_secret: string,
  short_lived_token: string,
): Promise<LongLivedToken> {
  const url = new URL("https://graph.instagram.com/access_token");
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", app_secret);
  url.searchParams.set("access_token", short_lived_token);

  const response = await fetch(url);

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not exchange for a long-lived token",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

type InstagramAccount = {
  user_id: string;
  id?: string; // older field name; `user_id` is the current one
  username?: string;
  name?: string;
  profile_picture_url?: string;
};

// Step 3: fetch the connected account's id and profile fields.
async function getInstagramAccount(
  access_token: string,
): Promise<InstagramAccount> {
  const url = new URL(`https://graph.instagram.com/${API_VERSION}/me`);
  url.searchParams.set("fields", "user_id,username,name,profile_picture_url");
  url.searchParams.set("access_token", access_token);

  const response = await fetch(url);

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not fetch Instagram account data",
      cause: await response.json().catch(() => ({})),
    });
  }

  const account = (await response.json()) as InstagramAccount;
  // `/me` may return `id` instead of `user_id` depending on the field set.
  return { ...account, user_id: account.user_id || account.id || "" };
}

// Step 4: subscribe the account to messaging webhooks.
async function subscribeToWebhooks(access_token: string): Promise<boolean> {
  const url = new URL(
    `https://graph.instagram.com/${API_VERSION}/me/subscribed_apps`,
  );
  url.searchParams.set("subscribed_fields", SUBSCRIBED_FIELDS);
  url.searchParams.set("access_token", access_token);

  const response = await fetch(url, { method: "POST" });

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not subscribe the account to webhooks",
      cause: await response.json().catch(() => ({})),
    });
  }

  return (await response.json()).success;
}

async function unsubscribeFromWebhooks(access_token: string): Promise<boolean> {
  const url = new URL(
    `https://graph.instagram.com/${API_VERSION}/me/subscribed_apps`,
  );
  url.searchParams.set("access_token", access_token);

  const response = await fetch(url, { method: "DELETE" });

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not unsubscribe the account from webhooks",
      cause: await response.json().catch(() => ({})),
    });
  }

  return (await response.json()).success;
}

async function refreshLongLivedToken(
  access_token: string,
): Promise<LongLivedToken> {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", access_token);

  const response = await fetch(url);

  if (!response.ok) {
    throw new HTTPException(response.status as ContentfulStatusCode, {
      message: "Could not refresh the long-lived token",
      cause: await response.json().catch(() => ({})),
    });
  }

  return await response.json();
}

function normalizePermissions(
  permissions: ShortLivedToken["permissions"],
): string[] {
  if (Array.isArray(permissions)) return permissions;
  if (typeof permissions === "string" && permissions.length > 0) {
    return permissions.split(",");
  }
  return [];
}

/**
 * Builds the Instagram Business Login authorize URL. The frontend redirects the
 * user here; Instagram redirects back to `redirect_uri` with a `code`. `state`
 * should carry the onboarding token for CSRF protection.
 */
export function buildAuthorizeUrl(
  redirect_uri: string,
  state?: string,
  application_id?: string,
): string {
  const { app_id } = resolveAppCredentials(application_id);

  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", app_id);
  url.searchParams.set("redirect_uri", redirect_uri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  if (state) url.searchParams.set("state", state);

  return url.toString();
}

export type InstagramLoginPayload = {
  code: string;
  redirect_uri: string;
  organization_id: string;
  application_id?: string;
};

/**
 * Runs the Instagram Business Login flow end to end and persists the connected
 * account into organizations_addresses. Mirrors whatsapp-management's
 * performEmbeddedSignup.
 */
export async function performInstagramLogin(
  client: Client,
  payload: InstagramLoginPayload,
) {
  if (!payload.code) {
    throw new HTTPException(400, { message: "Missing 'code' body param!" });
  }

  if (!payload.redirect_uri) {
    throw new HTTPException(400, {
      message: "Missing 'redirect_uri' body param!",
    });
  }

  if (!payload.organization_id) {
    throw new HTTPException(400, {
      message: "Missing 'organization_id' body param!",
    });
  }

  const { app_id, app_secret } = resolveAppCredentials(payload.application_id);

  // Attached to every step log so concurrent onboardings can be told apart in
  // stdout.
  const ctx = { organization_id: payload.organization_id };

  log.info("Step 1: Exchange the code for a short-lived token", ctx);
  const shortLived = await exchangeCodeForShortLivedToken(
    app_id,
    app_secret,
    payload.code,
    payload.redirect_uri,
  );

  log.info(
    "Step 2: Exchange the short-lived token for a long-lived token",
    ctx,
  );
  const longLived = await exchangeForLongLivedToken(
    app_secret,
    shortLived.access_token,
  );

  log.info("Step 3: Fetch the connected account's profile", ctx);
  const account = await getInstagramAccount(longLived.access_token);

  log.info("Step 4: Subscribe the account to webhooks", ctx);
  await subscribeToWebhooks(longLived.access_token);

  const ig_user_id = account.user_id || String(shortLived.user_id);
  const now = Date.now();

  const extra: InstagramOrganizationAddressExtra = {
    ig_user_id,
    username: account.username,
    name: account.name,
    profile_picture_url: account.profile_picture_url,
    access_token: longLived.access_token,
    token_expires_at: new Date(now + longLived.expires_in * 1000)
      .toISOString(),
    token_refreshed_at: new Date(now).toISOString(),
    scopes: normalizePermissions(shortLived.permissions),
  };

  log.info("Persisting Instagram account data", ctx);
  const { data, error } = await client
    .from("organizations_addresses")
    .upsert({
      service: "instagram",
      address: ig_user_id,
      organization_id: payload.organization_id,
      status: "connected",
      extra,
    })
    .select()
    .single();

  if (error) {
    throw new HTTPException(500, {
      message: "Could not persist Instagram account data",
      cause: error,
    });
  }

  log.info("Account connected", ctx);

  // Record the connection to public.logs (best-effort) so the org's
  // tech-provider sees good events too, not just failures.
  await client.from("logs").insert({
    organization_id: payload.organization_id,
    organization_address: data.address,
    category: "login",
    service: "instagram",
    level: "info",
    message: "Instagram account connected",
  });

  return data;
}

/**
 * Refreshes long-lived tokens that are near expiry. Invoked by the daily cron
 * (service-role authenticated). One failed account does not abort the rest.
 */
export async function refreshTokens(client: Client) {
  const { data: rows } = await client
    .from("organizations_addresses")
    .select("organization_id, address, service, extra")
    .eq("service", "instagram")
    .eq("status", "connected")
    .throwOnError();

  const now = Date.now();
  let refreshed = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.service !== "instagram") continue; // narrow the union

    const extra = (row.extra ?? {}) as InstagramOrganizationAddressExtra;
    const token = extra.access_token;

    if (!token) {
      skipped++;
      continue;
    }

    const expiresAt = extra.token_expires_at
      ? Date.parse(extra.token_expires_at)
      : 0;

    // Only refresh when within the window (or expiry unknown).
    if (extra.token_expires_at && expiresAt - now > REFRESH_WINDOW_MS) {
      skipped++;
      continue;
    }

    try {
      const longLived = await refreshLongLivedToken(token);

      await client
        .from("organizations_addresses")
        .update({
          extra: {
            access_token: longLived.access_token,
            token_expires_at: new Date(now + longLived.expires_in * 1000)
              .toISOString(),
            token_refreshed_at: new Date(now).toISOString(),
            needs_reauth: null,
          },
        })
        .eq("organization_id", row.organization_id)
        .eq("address", row.address)
        .throwOnError();

      refreshed++;
    } catch (error) {
      failed++;

      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to refresh Instagram token", {
        organization_id: row.organization_id,
        address: row.address,
        error: message,
      });

      // Flag the account so the UI can prompt a re-login; merge keeps the rest.
      await client
        .from("organizations_addresses")
        .update({ extra: { needs_reauth: new Date(now).toISOString() } })
        .eq("organization_id", row.organization_id)
        .eq("address", row.address);

      await client
        .from("logs")
        .insert({
          organization_id: row.organization_id,
          organization_address: row.address,
          category: "instagram_token_refresh",
          service: "instagram",
          level: "error",
          message,
        });
    }
  }

  log.info("Instagram token refresh summary", {
    total: rows.length,
    refreshed,
    failed,
    skipped,
  });

  return { total: rows.length, refreshed, failed, skipped };
}

/**
 * Disconnects an account: best-effort webhook unsubscribe, then marks the
 * address disconnected. Mirrors whatsapp-management's deleteSignup.
 */
export async function disconnect(
  client: Client,
  payload: { organization_id: string; ig_user_id: string },
) {
  const { organization_id, ig_user_id } = payload;

  const { data: row } = await client
    .from("organizations_addresses")
    .select("extra, service")
    .eq("organization_id", organization_id)
    .eq("address", ig_user_id)
    .eq("service", "instagram")
    .single()
    .throwOnError();

  const token = (row.extra as InstagramOrganizationAddressExtra | null)
    ?.access_token;

  if (token) {
    try {
      await unsubscribeFromWebhooks(token);
    } catch (error) {
      log.warn("Could not unsubscribe Instagram webhooks during disconnect", {
        organization_id,
        ig_user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const { data } = await client
    .from("organizations_addresses")
    .update({ status: "disconnected" })
    .eq("organization_id", organization_id)
    .eq("address", ig_user_id)
    .select()
    .single()
    .throwOnError();

  return data;
}

/**
 * Deletes the stored data for an Instagram account (data deletion request).
 * The IG-scoped `user_id` from the signed request is the value we store as the
 * organizations_addresses `address`.
 */
export async function deleteInstagramData(
  client: Client,
  ig_user_id: string,
): Promise<void> {
  await client
    .from("organizations_addresses")
    .delete()
    .eq("address", ig_user_id)
    .eq("service", "instagram")
    .throwOnError();
}

type SignedRequest = {
  user_id?: string;
  algorithm?: string;
  issued_at?: number;
};

/**
 * Parses and verifies a Meta `signed_request` (used by the deauthorize and data
 * deletion callbacks). The format is `<base64url(hmac)>.<base64url(payload)>`,
 * with the HMAC-SHA256 computed over the payload segment using the app secret.
 * Tries every configured app secret (multi-app `|` split). Returns null if the
 * signature does not verify.
 */
export async function parseSignedRequest(
  signedRequest: string,
): Promise<SignedRequest | null> {
  if (!APP_SECRET) {
    log.warn("INSTAGRAM_APP_SECRET environment variable not set");
    return null;
  }

  const [encodedSig, encodedPayload] = signedRequest.split(".");
  if (!encodedSig || !encodedPayload) return null;

  const encoder = new TextEncoder();
  const provided = decodeBase64Url(encodedSig);

  for (const secret of APP_SECRET.split("|")) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(encodedPayload)),
    );

    if (expected.length !== provided.length) continue;

    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ provided[i];
    if (diff !== 0) continue;

    return JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedPayload)),
    );
  }

  log.warn("signed_request signature did not verify against any app secret");
  return null;
}
