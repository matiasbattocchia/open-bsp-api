// Minimal TikTok API for Business client: the TikTok account holder OAuth
// (tt_user) and the account profile. Business Messaging calls build on
// tiktokApi.
//
// Every response comes in one envelope — `{ code, message, request_id, data }`
// — and a refusal is a non-zero `code`, usually on an HTTP 200.
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "./logger.ts";
import type {
  OrganizationAddressIssue,
  TikTokOrganizationAddressExtra,
} from "./types/extra_types.ts";

const API_URL = "https://business-api.tiktok.com/open_api/v1.3";
const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize";

const APP_ID = Deno.env.get("TIKTOK_APP_ID") ?? "";
const APP_SECRET = Deno.env.get("TIKTOK_APP_SECRET") ?? "";

/**
 * Scopes requested on authorize: the list in the developer portal's "TikTok
 * account holder authorization URL", which shows what the app was granted.
 */
export const SCOPES: string[] = [];

export class TikTokError extends Error {
  /** The envelope's code when TikTok answered; absent on a transport error. */
  code?: number;

  constructor(message: string, options?: { code?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "TikTokError";
    this.code = options?.code;
  }
}

type Envelope<T> = {
  code: number;
  message: string;
  request_id?: string;
  data?: T;
};

/**
 * Calls an API for Business endpoint. A body makes it a JSON POST; `query`
 * values that are not strings go JSON-encoded, as TikTok expects for list
 * parameters (`fields=["username"]`).
 */
export async function tiktokApi<T>(
  path: string,
  options: {
    access_token?: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const url = new URL(`${API_URL}${path}`);

  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }

  const response = await fetch(url, {
    method: options.body ? "POST" : "GET",
    headers: {
      ...(options.body && { "Content-Type": "application/json" }),
      ...(options.access_token && { "Access-Token": options.access_token }),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const envelope = await response.json().catch(() => null) as
    | Envelope<T>
    | null;

  if (!response.ok || !envelope) {
    throw new TikTokError(`TikTok ${path} answered HTTP ${response.status}`, {
      code: envelope?.code,
      cause: envelope ?? undefined,
    });
  }

  if (envelope.code !== 0) {
    throw new TikTokError(`TikTok ${path}: ${envelope.message}`, {
      code: envelope.code,
      cause: envelope,
    });
  }

  return envelope.data as T;
}

/** What tt_user/oauth2/token and tt_user/oauth2/refresh_token return. */
export type TikTokToken = {
  open_id: string;
  access_token: string;
  expires_in: number; // seconds (~24 hours)
  refresh_token: string;
  refresh_token_expires_in?: number; // seconds (~1 year)
  scope?: string | string[];
  token_type?: string;
};

function credentials() {
  if (!APP_ID || !APP_SECRET) {
    throw new TikTokError(
      "TIKTOK_APP_ID or TIKTOK_APP_SECRET environment variable not set",
    );
  }

  return { client_id: APP_ID, client_secret: APP_SECRET };
}

/**
 * Composes the TikTok account holder authorize URL. TikTok redirects back to
 * `redirect_uri` with a `code`; `state` guards it against CSRF.
 */
export function buildAuthorizeUrl(redirect_uri: string, state?: string) {
  const { client_id } = credentials();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_key", client_id);
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirect_uri);
  if (state) url.searchParams.set("state", state);

  return url.toString();
}

/** Exchanges an authorization code (valid an hour, once) for tokens. */
export async function exchangeCode(
  code: string,
  redirect_uri: string,
): Promise<TikTokToken> {
  return await tiktokApi<TikTokToken>("/tt_user/oauth2/token/", {
    body: {
      ...credentials(),
      grant_type: "authorization_code",
      auth_code: code,
      redirect_uri,
    },
  });
}

export async function refreshToken(
  refresh_token: string,
): Promise<TikTokToken> {
  return await tiktokApi<TikTokToken>("/tt_user/oauth2/refresh_token/", {
    body: {
      ...credentials(),
      grant_type: "refresh_token",
      refresh_token,
    },
  });
}

/** Revokes the account's authorization of the app. */
export async function revokeToken(access_token: string): Promise<void> {
  await tiktokApi("/tt_user/oauth2/revoke/", {
    body: { ...credentials(), access_token },
  });
}

export type TikTokProfile = {
  username?: string;
  display_name?: string;
  profile_image?: string;
};

export async function getProfile(
  open_id: string,
  access_token: string,
): Promise<TikTokProfile> {
  return await tiktokApi<TikTokProfile>("/business/get/", {
    access_token,
    query: {
      business_id: open_id,
      fields: ["username", "display_name", "profile_image"],
    },
  });
}

/** The token half of the address extra, as a fresh token sets it. */
export function tokenExtra(
  token: TikTokToken,
  previous_refresh_token?: string | null,
): TikTokOrganizationAddressExtra {
  const now = Date.now();
  const scopes = Array.isArray(token.scope)
    ? token.scope.map(String)
    : token.scope
    ? token.scope.split(",")
    : undefined;

  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token || previous_refresh_token,
    token_expires_at: new Date(now + token.expires_in * 1000).toISOString(),
    ...(token.refresh_token_expires_in && {
      refresh_token_expires_at: new Date(
        now + token.refresh_token_expires_in * 1000,
      ).toISOString(),
    }),
    token_refreshed_at: new Date(now).toISOString(),
    ...(scopes && { scopes }),
  };
}

/**
 * Flags a connected account whose authorization died — the refresh token
 * expired after a year, or the owner revoked it — so the account's members
 * are told to connect it again. The row stays connected and keeps its place
 * under the connections cap for the re-login. Flagging it again is a no-op for
 * the email (see notify_address_issue).
 */
export async function flagExpiredToken(
  client: SupabaseClient,
  organization_id: string,
  address: string,
): Promise<void> {
  log.error(`TikTok authorization dead for ${address}; flagging it expired`);

  const issue: OrganizationAddressIssue = { reason: "expired" };

  await client
    .from("organizations_addresses")
    .update({ issue })
    .eq("organization_id", organization_id)
    .eq("service", "tiktok")
    .eq("address", address)
    .eq("status", "connected")
    .throwOnError();
}

/**
 * Returns a usable access token for an account, refreshing (and persisting)
 * it first when it expires within `thresholdMs`. TikTok refusing the refresh
 * once the access token has lapsed means only a re-login helps, and the
 * account is flagged expired; while the token still has time, a refusal is
 * left to the next attempt.
 */
export async function ensureFreshToken(
  client: SupabaseClient,
  organization_id: string,
  address: string,
  extra: TikTokOrganizationAddressExtra,
  thresholdMs = 60 * 1000,
): Promise<string> {
  const { access_token, refresh_token, token_expires_at } = extra;

  if (!access_token || !refresh_token) {
    throw new TikTokError(`TikTok account ${address} holds no token`);
  }

  const expiresAt = token_expires_at ? Date.parse(token_expires_at) : 0;

  if (expiresAt - Date.now() > thresholdMs) return access_token;

  try {
    const token = await refreshToken(refresh_token);

    // merge_update keeps the untouched extra keys. A token that refreshes is
    // alive.
    await client
      .from("organizations_addresses")
      .update({ extra: tokenExtra(token, refresh_token), issue: null })
      .eq("organization_id", organization_id)
      .eq("service", "tiktok")
      .eq("address", address)
      .throwOnError();

    return token.access_token;
  } catch (error) {
    if (
      error instanceof TikTokError && error.code !== undefined &&
      expiresAt <= Date.now()
    ) {
      await flagExpiredToken(client, organization_id, address);
    }

    throw error;
  }
}
