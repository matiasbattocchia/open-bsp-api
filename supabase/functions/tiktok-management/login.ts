import * as log from "../_shared/logger.ts";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import {
  canConnect,
  isQuotaError,
  recordRefusedConnection,
} from "../_shared/connections.ts";
import {
  ensureFreshToken,
  exchangeCode,
  getProfile,
  refreshToken,
  revokeToken,
  type TikTokProfile,
  tokenExtra,
} from "../_shared/tiktok.ts";
import type {
  createClient,
  TikTokOrganizationAddressExtra,
} from "../_shared/supabase.ts";

// The cron sweeps every 4 hours; a token within this window of expiring is
// renewed on the sweep before, with hours to spare.
const REFRESH_WINDOW_MS = 8 * 60 * 60 * 1000; // 8 hours

type Client = ReturnType<typeof createClient>;

export type TikTokLoginPayload = {
  code: string;
  redirect_uri: string;
  organization_id: string;
  /**
   * Optional: connects the account as this member's PERSONAL channel — the
   * address row carries it, scoping its conversations to that member alone.
   * Absent is the org's shared inbox.
   */
  agent_id?: string;
  /** The onboarding link this signup came through; absent in the app. */
  onboarding_token_id?: string;
};

/**
 * Runs the TikTok account holder authorization end to end and persists the
 * connected account into organizations_addresses, keyed by its open_id.
 */
export async function performTikTokLogin(
  client: Client,
  payload: TikTokLoginPayload,
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

  // Attached to every step log so concurrent onboardings can be told apart in
  // stdout.
  const ctx = { organization_id: payload.organization_id };

  log.info("Step 1: Exchange the code for tokens", ctx);
  const token = await exchangeCode(payload.code, payload.redirect_uri);
  const open_id = token.open_id;

  if (
    !(await canConnect(client, payload.organization_id, "tiktok", {
      address: open_id,
    }))
  ) {
    await recordRefusedConnection(
      client,
      payload.organization_id,
      "tiktok",
      open_id,
    );
    // The grant is of no use to anyone now; leave nothing authorized at
    // TikTok for an account not connected here.
    await revokeToken(token.access_token).catch((error) =>
      log.warn("Could not revoke a refused TikTok grant", error)
    );
    throw new HTTPException(402, {
      message: "Usage limit reached for organizations_addresses",
    });
  }

  // Best-effort: the profile is how the account reads in the app, not what
  // makes it work, and reading it takes a scope the grant may lack.
  log.info("Step 2: Fetch the connected account's profile", ctx);
  const profile = await getProfile(open_id, token.access_token).catch(
    (error) => {
      log.warn("Could not fetch the TikTok profile", error);
      return {} as TikTokProfile;
    },
  );

  const extra: TikTokOrganizationAddressExtra = {
    open_id,
    username: profile.username,
    name: profile.display_name,
    profile_picture_url: profile.profile_image,
    ...tokenExtra(token),
    onboarding_token_id: payload.onboarding_token_id ?? null,
  };

  log.info("Persisting TikTok account data", ctx);
  const { data, error } = await client
    .from("organizations_addresses")
    .upsert({
      service: "tiktok",
      address: open_id,
      organization_id: payload.organization_id,
      agent_id: payload.agent_id ?? null,
      status: "connected",
      // A fresh login is what an expired authorization was waiting for.
      issue: null,
      extra,
    })
    .select()
    .single();

  if (error) {
    // The check above passed, but another account connected in between.
    if (isQuotaError(error)) {
      await recordRefusedConnection(
        client,
        payload.organization_id,
        "tiktok",
        open_id,
      );
      throw new HTTPException(402, { message: error.message, cause: error });
    }

    throw new HTTPException(500, {
      message: "Could not persist TikTok account data",
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
    service: "tiktok",
    level: "info",
    message: "TikTok account connected",
  });

  return data;
}

/**
 * Refreshes access tokens near expiry. Invoked by the cron (service-role
 * authenticated). One failed account does not abort the rest.
 */
export async function refreshTokens(client: Client) {
  const { data: rows } = await client
    .from("organizations_addresses")
    .select("organization_id, address, extra")
    .eq("service", "tiktok")
    .eq("status", "connected")
    .throwOnError();

  const now = Date.now();
  let refreshed = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    const extra = (row.extra ?? {}) as TikTokOrganizationAddressExtra;

    const expiresAt = extra.token_expires_at
      ? Date.parse(extra.token_expires_at)
      : 0;

    if (!extra.refresh_token || expiresAt - now > REFRESH_WINDOW_MS) {
      skipped++;
      continue;
    }

    try {
      await ensureFreshToken(
        client,
        row.organization_id,
        row.address,
        extra,
        REFRESH_WINDOW_MS,
      );

      refreshed++;
    } catch (error) {
      failed++;

      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to refresh TikTok token", {
        organization_id: row.organization_id,
        address: row.address,
        error: message,
      });

      await client
        .from("logs")
        .insert({
          organization_id: row.organization_id,
          organization_address: row.address,
          category: "tiktok_token_refresh",
          service: "tiktok",
          level: "error",
          message,
        });
    }
  }

  log.info("TikTok token refresh summary", {
    total: rows.length,
    refreshed,
    failed,
    skipped,
  });

  return { total: rows.length, refreshed, failed, skipped };
}

/**
 * Disconnects an account: revokes the app's authorization at TikTok
 * (best-effort), marks the address disconnected and clears its tokens — a
 * reconnect goes through TikTok's authorization again.
 */
export async function disconnect(
  client: Client,
  payload: { organization_id: string; open_id: string },
) {
  const { organization_id, open_id } = payload;

  const { data: row } = await client
    .from("organizations_addresses")
    .select("extra")
    .eq("organization_id", organization_id)
    .eq("service", "tiktok")
    .eq("address", open_id)
    .single()
    .throwOnError();

  const current = (row.extra ?? {}) as TikTokOrganizationAddressExtra;

  if (current.access_token) {
    try {
      // Revoking takes a live access token; a lapsed one is renewed just for
      // it.
      const lapsed = !current.token_expires_at ||
        Date.parse(current.token_expires_at) <= Date.now();
      const token = lapsed && current.refresh_token
        ? (await refreshToken(current.refresh_token)).access_token
        : current.access_token;

      await revokeToken(token);
    } catch (error) {
      log.warn("Could not revoke the TikTok authorization on disconnect", {
        organization_id,
        open_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // merge_update keeps the untouched extra keys.
  const extra: TikTokOrganizationAddressExtra = {
    access_token: null,
    refresh_token: null,
  };

  const { data } = await client
    .from("organizations_addresses")
    .update({ status: "disconnected", extra })
    .eq("organization_id", organization_id)
    .eq("service", "tiktok")
    .eq("address", open_id)
    .select()
    .single()
    .throwOnError();

  return data;
}
