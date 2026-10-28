import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./supabase.ts";
import * as log from "./logger.ts";
import type { OrganizationAddressIssue } from "./types/extra_types.ts";

type Service = Database["public"]["Enums"]["service"];

const PRODUCT = "organizations_addresses";

/** A billing-cap rejection. billing.check_limit raises SQLSTATE PT402 —
 * PostgREST maps that to HTTP 402 by itself, so callers see the code
 * directly; the Storage API instead flattens the trigger raise into its
 * message ("database error, code: PT402"), hence the text checks. */
export function isQuotaError(error: unknown): boolean {
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  return code === "PT402" || text.includes("PT402") ||
    /Usage limit reached for|Insufficient balance for/.test(text);
}

/**
 * Whether the organization may connect this account. True when it is already
 * connected — nothing new is being connected, a refresh never fails — and
 * otherwise the tier's connections cap decides, by billing.check_limit: the
 * same check the database runs when the row turns connected.
 *
 * Flows call it before any step outside the database, so a refusal leaves
 * nothing half-done at the provider (a WhatsApp number subscribed to our app,
 * say, with no account here to receive it). The account is matched by address
 * when the flow knows it, else by WABA.
 */
export async function canConnect(
  client: SupabaseClient<Database>,
  organization_id: string,
  service: Service,
  match: { address?: string; waba_id?: string },
): Promise<boolean> {
  if (match.address || match.waba_id) {
    let query = client
      .from("organizations_addresses")
      .select("address")
      .eq("organization_id", organization_id)
      .eq("service", service)
      .eq("status", "connected");

    query = match.address
      ? query.eq("address", match.address)
      : query.eq("extra->>waba_id", match.waba_id!);

    const { data } = await query.limit(1).throwOnError();
    if (data?.length) return true;
  }

  const { error } = await client.schema("billing").rpc("check_limit", {
    _organization_id: organization_id,
    _product_id: PRODUCT,
  });

  if (!error) return true;
  if (isQuotaError(error)) return false;
  throw error;
}

/**
 * The issues Meta holds an account by: until Meta reinstates it, a WhatsApp
 * Business account reported for a violation or disabled can't be connected,
 * in its organization or in any other.
 */
export const META_FLAGS: OrganizationAddressIssue["reason"][] = [
  "violation",
  "banned",
];

/**
 * Why Meta holds this WhatsApp Business account, if it does: the issue on any
 * of its accounts, in whichever organization. Read across organizations, so
 * it needs the service-role client.
 */
export async function heldByMeta(
  client: SupabaseClient<Database>,
  waba_id: string,
): Promise<OrganizationAddressIssue | null> {
  const { data } = await client
    .from("organizations_addresses")
    .select("issue")
    .eq("service", "whatsapp")
    .eq("extra->>waba_id", waba_id)
    .in("issue->>reason", META_FLAGS)
    .limit(1)
    .throwOnError();

  return (data[0]?.issue as OrganizationAddressIssue | undefined) ?? null;
}

/**
 * Records a refused connection where the organization will find it, for the
 * refusals nobody watches happen — a provider webhook reconnecting an account,
 * the bridge reporting a paired session — and the ones a person does see, so
 * there is one trail: a warning in the organization's logs, and the
 * connections "capped" alert, which emails every member once (an alert
 * already on record stays quiet). Best-effort: a refusal is already the
 * outcome, and recording it must not turn it into a failure.
 */
export async function recordRefusedConnection(
  client: SupabaseClient<Database>,
  organization_id: string,
  service: Service,
  address: string | undefined,
) {
  try {
    const { data: row } = address
      ? await client
        .from("organizations_addresses")
        .select("address")
        .eq("organization_id", organization_id)
        .eq("service", service)
        .eq("address", address)
        .maybeSingle()
      : { data: null };

    await client.from("logs").insert({
      organization_id,
      // The logs reference an account only once it exists here.
      organization_address: row?.address ?? null,
      service,
      category: "billing",
      level: "warning",
      message: "Account not connected: the plan's connection limit is reached",
      metadata: { product: PRODUCT, address: address ?? null },
    }).throwOnError();

    const [{ data: subscription }, { data: usage }] = await Promise.all([
      client.schema("billing").from("subscriptions").select("tier_id").eq(
        "organization_id",
        organization_id,
      ).single().throwOnError(),
      client.schema("billing").from("usage").select("quantity").eq(
        "organization_id",
        organization_id,
      ).eq("product_id", PRODUCT).eq("interval", "lifetime").maybeSingle()
        .throwOnError(),
    ]);

    const { data: tier } = await client.schema("billing").from(
      "tiers_products",
    ).select("cap").eq("tier_id", subscription.tier_id).eq(
      "product_id",
      PRODUCT,
    ).single().throwOnError();

    if (usage && tier.cap !== null) {
      await client.schema("billing").from("alerts").upsert({
        organization_id,
        product_id: PRODUCT,
        interval: "lifetime",
        period: "1970-01-01",
        level: "capped",
        quantity: usage.quantity,
        cap: tier.cap,
      }, { ignoreDuplicates: true }).throwOnError();
    }
  } catch (error) {
    log.error("Could not record a refused connection", {
      organization_id,
      service,
      address,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
