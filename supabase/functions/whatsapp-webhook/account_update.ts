import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import type { Database, Json } from "../_shared/supabase.ts";
import type { WebhookAccountUpdateValue } from "../_shared/types/whatsapp_webhook_payload_types.ts";
import type { OrganizationAddressIssue } from "../_shared/types/extra_types.ts";
import {
  isQuotaError,
  META_FLAGS,
  recordRefusedConnection,
} from "../_shared/connections.ts";

const APP_ID = Deno.env.get("META_APP_ID");

type Account = {
  organization_id: string;
  address: string;
  status: string;
  issue: Json | null;
  phone_number: string | null;
};

/**
 * What a Meta event does to one of the WABA's accounts here: disconnect it,
 * with the issue that says why, connect it again, or leave it connected with
 * an issue (or without its last one). Nothing for an account the event leaves
 * as it is.
 */
type Change =
  | { status: "disconnected"; issue: OrganizationAddressIssue }
  | { status: "connected"; reinstated: boolean }
  | { issue: OrganizationAddressIssue | null }
  | null;

const reasonOf = (account: Account) =>
  (account.issue as OrganizationAddressIssue | null)?.reason;

const flagged = (account: Account) => META_FLAGS.includes(reasonOf(account)!);

/**
 * Meta's account events, as they bear on our accounts:
 *
 *   PARTNER_REMOVED, PARTNER_APP_UNINSTALLED (our app)  removed
 *   ACCOUNT_DELETED, PHONE_NUMBER_REMOVED (that number) deleted
 *   ACCOUNT_OFFBOARDED                                  offboarded
 *   ACCOUNT_VIOLATION                                   violation
 *   DISABLED_UPDATE, DISABLE                            banned
 *   DISABLED_UPDATE, REINSTATE                          connected again
 *   ACCOUNT_RECONNECTED                                 connected again
 *   ACCOUNT_RESTRICTION                                 restricted
 *
 * Each of the first five takes a connected account away; a restriction
 * leaves it connected, limited until the restriction expires. A violation or
 * a ban takes every account of the WABA, connected or not, and holds it: the
 * account can't be connected again, here or in another organization, until
 * Meta reinstates it. A violation alone is acted on as if it were final —
 * a free tier is not worth our standing with Meta — and reversing a mistake
 * is a reinstatement, or us connecting the account again by hand.
 */
function changeFor(
  value: WebhookAccountUpdateValue,
  account: Account,
): Change {
  const connected = account.status === "connected";
  const disconnect = (issue: OrganizationAddressIssue): Change => ({
    status: "disconnected",
    issue,
  });

  switch (value.event) {
    case "PARTNER_REMOVED":
      return connected
        ? disconnect({
          reason: "removed",
          ...(value.disconnection_info
            ? { detail: value.disconnection_info.reason }
            : {}),
        })
        : null;
    case "PARTNER_APP_UNINSTALLED":
      // An uninstall names the app, and only ours counts.
      return connected &&
          (!APP_ID ||
            APP_ID.split("|").includes(value.waba_info.partner_app_id))
        ? disconnect({ reason: "removed" })
        : null;
    case "ACCOUNT_DELETED":
      return connected ? disconnect({ reason: "deleted" }) : null;
    case "PHONE_NUMBER_REMOVED":
      return connected &&
          account.phone_number?.replace(/\D/g, "") === value.phone_number
        ? disconnect({ reason: "deleted" })
        : null;
    case "ACCOUNT_OFFBOARDED":
      return connected ? disconnect({ reason: "offboarded" }) : null;
    case "ACCOUNT_VIOLATION":
      return flagged(account) ? null : disconnect({
        reason: "violation",
        detail: value.violation_info.violation_type,
      });
    case "DISABLED_UPDATE":
      switch (value.ban_info.waba_ban_state) {
        case "DISABLE":
          return reasonOf(account) === "banned"
            ? null
            : disconnect({ reason: "banned" });
        case "REINSTATE":
          return !connected && flagged(account)
            ? { status: "connected", reinstated: true }
            : null;
        default:
          // Scheduled for disable: Meta may still change its mind.
          return null;
      }
    case "ACCOUNT_RESTRICTION": {
      // Never over another issue, which says more about the account. No
      // restrictions left is the last one lifted.
      if (
        !connected || (reasonOf(account) && reasonOf(account) !== "restricted")
      ) {
        return null;
      }
      const restrictions = value.restriction_info ?? [];
      if (!restrictions.length) {
        return reasonOf(account) ? { issue: null } : null;
      }
      return {
        issue: {
          reason: "restricted",
          until: new Date(
            Math.max(...restrictions.map((r) => r.expiration)) * 1000,
          ).toISOString(),
          // Comma-separated when there are several.
          detail: restrictions.map((r) => r.restriction_type).join(","),
        },
      };
    }
    case "ACCOUNT_RECONNECTED":
      // The number set up in the app again (device switch, reinstall,
      // re-registration). Not one Meta holds, nor one that no longer exists.
      return !connected && !flagged(account) &&
          reasonOf(account) !== "deleted"
        ? { status: "connected", reinstated: false }
        : null;
    default:
      return null;
  }
}

/**
 * A WABA-level event from Meta: logged for the organizations that hold the
 * WABA, and applied to its accounts there.
 *
 * The holders are the organizations with one of its accounts connected, or,
 * with none connected, the one that connected it last: a WABA that moved on
 * from an organization long ago is no longer that organization's news.
 */
export async function handleAccountUpdate(
  client: SupabaseClient<Database>,
  waba_id: string,
  value: WebhookAccountUpdateValue,
) {
  const { data: rows } = await client
    .from("organizations_addresses")
    .select(
      "organization_id, address, status, issue, phone_number:extra->>phone_number, created_at",
    )
    .eq("service", "whatsapp")
    .eq("extra->>waba_id", waba_id)
    .order("created_at", { ascending: false })
    .throwOnError();

  if (!rows.length) {
    log.warn(
      "Could not log account update payload: No organization found for WABA",
      value,
    );
    return;
  }

  const connectedIn = new Set(
    rows.filter((row) => row.status === "connected").map((row) =>
      row.organization_id
    ),
  );
  const holders = connectedIn.size
    ? connectedIn
    : new Set([rows[0].organization_id]);
  const accounts: Account[] = rows.filter((row) =>
    holders.has(row.organization_id)
  );

  const changes = accounts.map((account) => ({
    account,
    change: changeFor(value, account),
  })).filter(({ change }) => change);

  const serious =
    changes.some(({ change }) =>
      change && "status" in change && change.status === "disconnected"
    ) ||
    value.event === "ACCOUNT_RESTRICTION" ||
    value.event === "DISABLED_UPDATE";

  log.info("Account update event", {
    organizations: [...holders],
    event: value.event,
    waba_id,
  });

  for (const organization_id of holders) {
    await client
      .from("logs")
      .insert({
        organization_id,
        category: "account_update",
        service: "whatsapp",
        level: serious ? "warning" : "info",
        message: value.event.toLocaleLowerCase(),
        metadata: { waba_id, value } as unknown as Json,
      })
      .throwOnError();
  }

  for (const { account, change } of changes) {
    log.info(`Account ${value.event}, setting address status`, {
      organization_id: account.organization_id,
      address: account.address,
      change,
    });

    const update = (fields: {
      status?: string;
      issue?: OrganizationAddressIssue | null;
    }) =>
      client
        .from("organizations_addresses")
        .update(fields)
        .eq("organization_id", account.organization_id)
        .eq("service", "whatsapp")
        .eq("address", account.address);

    const { error } = await update(
      !("status" in change!)
        ? { issue: change!.issue }
        : change!.status === "disconnected"
        ? { status: "disconnected", issue: change!.issue }
        : { status: "connected" },
    );

    if (!error) continue;

    // A reconnect over the connections cap stays disconnected. Meta must not
    // be answered with an error (it would retry the event for days), so the
    // refusal is recorded for the organization instead. A reinstated account
    // is no longer Meta's to hold, so it loses the flag and can be connected
    // again once there is room.
    if (
      "status" in change! && change.status === "connected" &&
      isQuotaError(error)
    ) {
      await recordRefusedConnection(
        client,
        account.organization_id,
        "whatsapp",
        account.address,
      );

      if (change.reinstated) {
        await update({ issue: null }).throwOnError();
      }
    } else {
      throw error;
    }
  }
}
