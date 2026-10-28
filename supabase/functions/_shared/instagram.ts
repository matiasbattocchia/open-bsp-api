// Instagram helpers shared by the webhook and the dispatcher.
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "./logger.ts";
import type { OrganizationAddressIssue } from "./types/extra_types.ts";

/**
 * Flags a connection whose token proved dead (Graph error 190) with the
 * `expired` issue, so the UI warns and asks for a re-login, and whoever can
 * reconnect it gets an email — the same flag the refresh sweep sets when a
 * refresh is refused. Detection matters outside the sweep: the sweep only
 * attempts tokens within 10 days of expiry, so a token revoked mid-life
 * (password change, forced session invalidation) would otherwise fail
 * silently for weeks. The row stays connected: webhooks keep flowing after a
 * password change, and the account keeps its place under the connections cap
 * for the re-login. Flagging it again is a no-op for the email (see
 * notify_address_issue).
 */
export async function flagExpiredToken(
  client: SupabaseClient,
  organization_id: string,
  address: string,
): Promise<void> {
  log.error(`Instagram token dead for ${address}; flagging it expired`);

  const issue: OrganizationAddressIssue = { reason: "expired" };

  await client
    .from("organizations_addresses")
    .update({ issue })
    .eq("organization_id", organization_id)
    .eq("service", "instagram")
    .eq("address", address)
    .eq("status", "connected")
    .throwOnError();
}
