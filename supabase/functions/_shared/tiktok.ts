// Minimal TikTok API for Business client: the TikTok account holder OAuth
// (tt_user), the account profile and the Business Messaging calls.
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
  /** The HTTP status, when the response was not a 200. */
  status?: number;

  constructor(
    message: string,
    options?: { code?: number; status?: number; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "TikTokError";
    this.code = options?.code;
    this.status = options?.status;
  }
}

/**
 * Throttling, per TikTok's return codes: app-level (40016, 40100),
 * advertiser-level (40133) and field-level (40132).
 */
const RATE_LIMIT_CODES = new Set([40016, 40100, 40132, 40133]);

/**
 * Whether TikTok refused the access token as incorrect or revoked (40105) —
 * the owner took the authorization back, and only a re-login helps.
 */
export function isDeadToken(error: unknown): boolean {
  return error instanceof TikTokError && error.code === 40105;
}

/**
 * Whether TikTok asked us to slow down — a reason to try again later, never a
 * verdict on the token or the message.
 */
export function isRateLimited(error: unknown): boolean {
  return error instanceof TikTokError &&
    (error.status === 429 ||
      (error.code !== undefined && RATE_LIMIT_CODES.has(error.code)));
}

type Envelope<T> = {
  code: number;
  message: string;
  request_id?: string;
  data?: T;
};

/**
 * Calls an API for Business endpoint. A body makes it a JSON POST, a form a
 * multipart one; `query` values that are not strings go JSON-encoded, as
 * TikTok expects for list parameters (`fields=["username"]`).
 */
export async function tiktokApi<T>(
  path: string,
  options: {
    access_token?: string;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    form?: FormData;
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
    method: options.body || options.form ? "POST" : "GET",
    headers: {
      ...(options.body && { "Content-Type": "application/json" }),
      ...(options.access_token && { "Access-Token": options.access_token }),
    },
    body: options.body ? JSON.stringify(options.body) : options.form,
    // The token rides in a header a cross-origin redirect would carry along.
    redirect: "error",
  });

  const envelope = await response.json().catch(() => null) as
    | Envelope<T>
    | null;

  if (!response.ok || !envelope) {
    throw new TikTokError(`TikTok ${path} answered HTTP ${response.status}`, {
      code: envelope?.code,
      status: response.status,
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
 * left to the next attempt, and so is being throttled, whenever it happens.
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
    // Not TikTok's answer: nothing to send it with until someone reconnects.
    throw new Error(`TikTok account ${address} holds no token`);
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
      !isRateLimited(error) && expiresAt <= Date.now()
    ) {
      await flagExpiredToken(client, organization_id, address);
    }

    throw error;
  }
}

// Business Messaging

/** What /business/message/send/ takes beside business_id and recipient. */
export type TikTokSendBody =
  | {
    message_type: "TEXT";
    text: { body: string };
    referenced_message_info?: { referenced_message_id: string };
  }
  | { message_type: "IMAGE"; image: { media_id: string } }
  | { message_type: "SHARE_POST"; share_post: { item_id: string } }
  | { message_type: "SENDER_ACTION"; sender_action: "TYPING" | "MARK_READ" };

/**
 * Sends to a conversation. The message id is empty for a sender action, which
 * sends nothing.
 */
export async function sendMessage(
  business_id: string,
  conversation_id: string,
  access_token: string,
  body: TikTokSendBody,
): Promise<string | undefined> {
  const data = await tiktokApi<{ message?: { message_id?: string } }>(
    "/business/message/send/",
    {
      access_token,
      body: {
        business_id,
        recipient_type: "CONVERSATION",
        recipient: conversation_id,
        ...body,
      },
    },
  );

  return data?.message?.message_id || undefined;
}

/** Uploads an image (JPG or PNG, up to 3 MB) and returns its media_id. */
export async function uploadImage(
  business_id: string,
  access_token: string,
  file: Blob,
  name: string,
): Promise<string> {
  const form = new FormData();
  form.append("business_id", business_id);
  form.append("media_type", "IMAGE");
  form.append("file", file, name);

  const data = await tiktokApi<{ media_id?: string }>(
    "/business/message/media/upload/",
    { access_token, form },
  );

  if (!data?.media_id) {
    throw new TikTokError("TikTok media upload returned no media_id", {
      cause: data,
    });
  }

  return data.media_id;
}

/**
 * Downloads an image or a video a message carries. TikTok hands out a URL,
 * valid a day, that answers only with the access token in `x-user`.
 */
export async function downloadMedia(
  access_token: string,
  media: {
    business_id: string;
    conversation_id: string;
    message_id: string;
    media_id: string;
    media_type: "IMAGE" | "VIDEO";
  },
): Promise<Blob> {
  const data = await tiktokApi<{ download_url?: string }>(
    "/business/message/media/download/",
    { access_token, body: media },
  );

  if (!data?.download_url) {
    throw new TikTokError("TikTok media download returned no URL", {
      cause: data,
    });
  }

  const response = await fetch(data.download_url, {
    headers: { "x-user": access_token },
    redirect: "error",
  });

  if (!response.ok) {
    throw new TikTokError(
      `TikTok media download answered HTTP ${response.status}`,
      { status: response.status },
    );
  }

  return await response.blob();
}

/** A conversation's participant, as /business/message/content/list/ has it. */
export type TikTokParticipant = {
  role?: string;
  id?: string;
  display_name?: string;
  profile_image?: string;
};

/** The participants of a conversation: the business and the customer. */
export async function listParticipants(
  business_id: string,
  conversation_id: string,
  access_token: string,
): Promise<TikTokParticipant[]> {
  const data = await tiktokApi<{ participants?: TikTokParticipant[] }>(
    "/business/message/content/list/",
    { access_token, query: { business_id, conversation_id } },
  );

  return data?.participants ?? [];
}

/**
 * Points the app's DIRECT_MESSAGE webhook at `callback_url`. There is one per
 * app, not per account: every authorized account's messages go there.
 */
export async function updateWebhook(callback_url: string) {
  const { client_id, client_secret } = credentials();

  return await tiktokApi<unknown>("/business/webhook/update/", {
    body: {
      app_id: client_id,
      secret: client_secret,
      event_type: "DIRECT_MESSAGE",
      callback_url,
    },
  });
}

/** The app's DIRECT_MESSAGE webhook, as TikTok has it. */
export async function getWebhook() {
  const { client_id, client_secret } = credentials();

  return await tiktokApi<unknown>("/business/webhook/list/", {
    query: {
      app_id: client_id,
      secret: client_secret,
      event_type: "DIRECT_MESSAGE",
    },
  });
}

/**
 * Verifies a webhook's `TikTok-Signature: t=<seconds>,s=<hex>`, the
 * HMAC-SHA256 of `${t}.${body}` under the app secret, and that it was signed
 * within `toleranceSec` — the timestamp is signed, so bounding its age is
 * what stops a replay.
 */
export async function verifySignature(
  body: string,
  header: string | null,
  toleranceSec = 300,
): Promise<boolean> {
  if (!header || !APP_SECRET) return false;

  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const element of header.split(",")) {
    const [key, value] = element.split("=", 2).map((v) => v?.trim());
    if (key === "t" && /^\d+$/.test(value ?? "")) timestamp = Number(value);
    if (key === "s" && value) signatures.push(value.toLowerCase());
  }

  if (timestamp === undefined || signatures.length === 0) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${timestamp}.${body}`),
    ),
  );
  const expected = Array.from(digest)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time over equal lengths.
  const matches = signatures.some((signature) => {
    if (signature.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  });

  return matches &&
    Math.abs(Date.now() / 1000 - timestamp) <= toleranceSec;
}
