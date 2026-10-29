// Minimal Slack Web API client. We keep our own fetch/retry/pagination layer
// (the official WebClient is a heavy runtime dependency for an edge function),
// but every response shape is the OFFICIAL one: the `@slack/web-api` types are
// generated from Slack's API and imported `import type`, which TypeScript
// erases entirely — the deployed bundle pulls in no Slack code at all
// (verified: a type-only import runs under `deno run` with zero permissions).
//
// The payoff is SLACK_METHODS below: `slackApi("chat.postMessage", …)` infers
// ChatPostMessageResponse with no annotation, so every call site is checked
// against the real API instead of the `Record<string, unknown>` we used to
// cast our way out of. Adding a method means adding a line to that map.
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AppsEventAuthorizationsListResponse,
  AuthRevokeResponse,
  ChatPostMessageResponse,
  ConversationsInfoResponse,
  FilesCompleteUploadExternalResponse,
  FilesGetUploadURLExternalResponse,
  OauthV2AccessResponse,
  ReactionsAddResponse,
  ReactionsRemoveResponse,
  UsersConversationsResponse,
  UsersInfoResponse,
  UsersListResponse,
} from "@slack/web-api";
import * as log from "../_shared/logger.ts";
import type { OrganizationAddressIssue } from "./types/extra_types.ts";

const CLIENT_ID = Deno.env.get("SLACK_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("SLACK_CLIENT_SECRET") ?? "";

/**
 * What an install grants. Slack's authorize endpoint takes `user_scope` and
 * `scope` (bot) independently, so one flow can request either or both —
 * see buildAuthorizeUrl.
 *
 * They are not two flavours of the same thing. A user connection is personal
 * and repeatable (each member connects their own account); a bot install is
 * workspace-wide and singular — one bot per app per workspace, reachable by
 * every member, usually behind admin approval.
 */
export type ConnectMode = "user" | "bot" | "both";

/**
 * User scopes requested on install. The app acts as the member (xoxp token):
 * their DMs, group DMs and channels. Keep this list in sync with the app
 * manifest — Slack rejects tokens whose grant is narrower than what an API
 * call needs, and marketplace review audits every entry.
 */
export const USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "chat:write",
  "users:read",
  "files:read",
  "files:write",
  "reactions:read",
  "reactions:write",
] as const;

/**
 * Bot scopes, for a workspace-wide install. In OAuth v2 the scope NAMES are
 * shared between bot and user grants — what differs is the parameter they go
 * in — so this mirrors USER_SCOPES today. Kept as its own list because the
 * app manifest declares them separately and they will diverge (a bot may
 * want channels:join; a bot never needs the member's own DM history).
 *
 * Declaring these in the manifest is what marketplace review audits, whether
 * or not a given install requests them.
 */
export const BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "chat:write",
  "users:read",
  "files:read",
  "files:write",
  "reactions:read",
  "reactions:write",
] as const;

export class SlackError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SlackError";
  }
}

/**
 * Every Slack Web API method we call, mapped to its official response type.
 * This is the allowlist: `slackApi` only accepts these keys, so a typo or an
 * ungrounded method is a compile error rather than a runtime `ok: false`.
 *
 * `oauth.v2.access` covers both grants (authorization_code on install,
 * refresh_token on rotation) — Slack returns the same envelope for each.
 */
export type SlackMethods = {
  "apps.event.authorizations.list": AppsEventAuthorizationsListResponse;
  "auth.revoke": AuthRevokeResponse;
  "chat.postMessage": ChatPostMessageResponse;
  "conversations.info": ConversationsInfoResponse;
  "files.completeUploadExternal": FilesCompleteUploadExternalResponse;
  "files.getUploadURLExternal": FilesGetUploadURLExternalResponse;
  "oauth.v2.access": OauthV2AccessResponse;
  "reactions.add": ReactionsAddResponse;
  "reactions.remove": ReactionsRemoveResponse;
  "users.conversations": UsersConversationsResponse;
  "users.info": UsersInfoResponse;
  "users.list": UsersListResponse;
};

/**
 * OAuth envelope. Aliased to the official response so the bot-token fields
 * (top-level `access_token`/`bot_user_id`, populated only when the authorize
 * URL requests `scope` as well as `user_scope`) are visible if we ever add a
 * bot — today we read `authed_user` only.
 */
export type OauthAccess = OauthV2AccessResponse;

/**
 * Domain shapes, derived rather than hand-copied so they cannot drift from
 * the API. `users.list` members and `users.info` user are the same object in
 * Slack's schema; we key off the list form because that is the bulk path.
 */
export type SlackUser = NonNullable<UsersListResponse["members"]>[number];
export type SlackChannel = NonNullable<
  UsersConversationsResponse["channels"]
>[number];

/** Fields common to every Slack response, regardless of method. */
type SlackEnvelope = {
  ok?: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
};

/**
 * Calls a Slack Web API method (form-encoded, as Slack prefers for GET-style
 * methods). Throws SlackError on `ok: false`; retries once on HTTP 429
 * honoring Retry-After.
 */
export async function slackApi<M extends keyof SlackMethods>(
  method: M,
  token: string | null,
  params: Record<string, string> = {},
  attempt = 0,
): Promise<SlackMethods[M]> {
  const body = new URLSearchParams(params);

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });

  if (response.status === 429 && attempt < 2) {
    const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
    log.warn(`Slack ${method} rate limited, retrying in ${retryAfter}s`);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    return await slackApi(method, token, params, attempt + 1);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.ok) {
    throw new SlackError(`Slack ${method} failed: ${payload.error}`, {
      cause: payload,
    });
  }

  return payload as SlackMethods[M];
}

/**
 * Iterates a cursor-paginated Slack method, yielding the items under `key`
 * page by page. `maxPages` bounds runaway workspaces; callers log truncation.
 */
export async function* slackPaginate<
  M extends keyof SlackMethods,
  K extends keyof SlackMethods[M],
>(
  method: M,
  token: string,
  key: K,
  params: Record<string, string> = {},
  maxPages = 25,
): AsyncGenerator<NonNullable<SlackMethods[M][K]>, void, unknown> {
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const payload = await slackApi(method, token, {
      ...params,
      limit: "200",
      ...(cursor ? { cursor } : {}),
    }) as SlackMethods[M] & SlackEnvelope;

    yield (payload[key] ?? []) as NonNullable<SlackMethods[M][K]>;

    cursor = payload.response_metadata?.next_cursor || undefined;
    if (!cursor) return;
  }

  log.warn(`Slack ${method} pagination truncated after ${maxPages} pages`);
}

/** Exchanges an OAuth code (initial install). */
export async function oauthAccess(
  code: string,
  redirect_uri: string,
): Promise<OauthAccess> {
  return await slackApi("oauth.v2.access", null, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri,
  }) as OauthAccess;
}

/** Refreshes a rotated user token. */
export async function oauthRefresh(
  refresh_token: string,
): Promise<OauthAccess> {
  return await slackApi("oauth.v2.access", null, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token,
  }) as OauthAccess;
}

/**
 * Composes the install URL. `mode` selects which grant is requested:
 * "user" sets user_scope only, "bot" sets scope only, "both" sets each — a
 * single flow can carry both, and oauth.v2.access then returns the bot token
 * at the top level and the user token under authed_user.
 */
export function buildAuthorizeUrl(
  redirect_uri: string,
  state?: string,
  mode: ConnectMode = "user",
): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  if (mode !== "bot") url.searchParams.set("user_scope", USER_SCOPES.join(","));
  if (mode !== "user") url.searchParams.set("scope", BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", redirect_uri);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/** Fetches a single user's profile (any workspace user token works). */
export async function usersInfo(
  token: string,
  user: string,
): Promise<SlackUser | null> {
  try {
    const payload = await slackApi("users.info", token, { user });
    return (payload.user ?? null) as SlackUser | null;
  } catch (error) {
    log.warn(`Slack users.info failed for ${user}`, error);
    return null;
  }
}

/**
 * Full list of installations an event applies to. The event payload itself
 * carries at most one authorization; this API (app-level xapp token) returns
 * them all. SLACK_APP_TOKEN is expected configuration — without it callers
 * degrade to the payload's partial list, which under-grants visibility on
 * first contact with a channel when several members are connected.
 */
export async function eventAuthorizations(
  event_context: string,
): Promise<Array<{ user_id: string; is_bot?: boolean }> | null> {
  const appToken = Deno.env.get("SLACK_APP_TOKEN");

  if (!appToken) {
    log.error(
      "SLACK_APP_TOKEN is not configured; falling back to the event's partial authorizations",
    );
    return null;
  }

  try {
    const payload = await slackApi(
      "apps.event.authorizations.list",
      appToken,
      { event_context },
    );
    return (payload.authorizations ?? []) as Array<
      { user_id: string; is_bot?: boolean }
    >;
  } catch (error) {
    log.warn("apps.event.authorizations.list failed", error);
    return null;
  }
}

/**
 * Slack error codes meaning the token/grant is dead and only a reconnect can
 * fix it (as opposed to transient failures worth retrying).
 * invalid_refresh_token: refresh tokens are single-use — a revoked grant or a
 * race that spent the same refresh token twice leaves the stored one dead.
 */
export const DEAD_TOKEN_ERRORS = new Set([
  "token_revoked",
  "token_expired",
  "invalid_auth",
  "account_inactive",
  "invalid_refresh_token",
]);

/** A member's personal connection row (address `T…:U…`), extra subset. */
export type SlackConnection = {
  address: string;
  extra: {
    access_token?: string | null;
    refresh_token?: string | null;
    expires_at?: string | null;
  };
};

/**
 * Flips a connection (a member's, or the workspace anchor) to disconnected
 * and clears its secrets so the UI prompts a reconnect, its issue saying the
 * token died — same semantics as the tokens_revoked webhook. merge_update
 * keeps the untouched extra keys. Only a connected row: one a member
 * disconnected is theirs.
 */
export async function disconnectConnection(
  client: SupabaseClient,
  organization_id: string,
  address: string,
): Promise<void> {
  await client
    .from("organizations_addresses")
    .update({
      status: "disconnected",
      issue: { reason: "expired" } satisfies OrganizationAddressIssue,
      extra: { access_token: null, refresh_token: null },
    })
    .eq("organization_id", organization_id)
    .eq("service", "slack")
    .eq("address", address)
    .eq("status", "connected")
    .throwOnError();
}

/**
 * Returns a usable access token for a connection, refreshing (and persisting)
 * it first when it expires within `thresholdMs`. Rotation-off tokens carry no
 * expires_at/refresh_token and pass straight through. A dead refresh token
 * (DEAD_TOKEN_ERRORS) disconnects the connection before rethrowing, so every
 * caller — dispatcher, webhook reads, cron sweep — converges on the same
 * reconnect-prompt semantics.
 */
export async function ensureFreshToken(
  client: SupabaseClient,
  organization_id: string,
  connection: SlackConnection,
  thresholdMs = 60 * 1000,
): Promise<string> {
  const { access_token, refresh_token, expires_at } = connection.extra;

  // No refresh_token = rotation off, the token never expires. With one, an
  // absent expires_at is anomalous — treat it as expiring (refresh now).
  const expiringSoon = !expires_at ||
    new Date(expires_at).getTime() - Date.now() < thresholdMs;

  if (!refresh_token || !expiringSoon) return access_token!;

  try {
    const access = await oauthRefresh(refresh_token);
    const authed = access.authed_user;

    if (!authed?.access_token) {
      throw new SlackError("Refresh response missing access_token", {
        cause: access,
      });
    }

    // merge_update keeps the untouched extra keys.
    await client
      .from("organizations_addresses")
      .update({
        extra: {
          access_token: authed.access_token,
          refresh_token: authed.refresh_token ?? refresh_token,
          expires_at: authed.expires_in
            ? new Date(Date.now() + authed.expires_in * 1000).toISOString()
            : undefined,
        },
      })
      .eq("organization_id", organization_id)
      .eq("service", "slack")
      .eq("address", connection.address)
      .throwOnError();

    return authed.access_token;
  } catch (error) {
    const code = error instanceof SlackError
      ? (error.cause as { error?: string } | undefined)?.error
      : undefined;

    if (code && DEAD_TOKEN_ERRORS.has(code)) {
      log.error(
        `Slack refresh token dead for ${connection.address} (${code}); disconnecting`,
      );
      await disconnectConnection(client, organization_id, connection.address);
    }

    throw error;
  }
}
