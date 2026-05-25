import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./supabase.ts";

/**
 * Get a secret for an organization address from the organization_secrets table.
 * Falls back to organizations_addresses.extra for backwards compatibility.
 * Requires service_role client (RLS blocks authenticated users).
 */
export async function getSecret(
  client: SupabaseClient<Database>,
  organizationId: string,
  address: string,
  key: string,
): Promise<string | null> {
  // Try new secrets table first
  const { data } = await client
    .from("organization_secrets")
    .select("value")
    .eq("organization_id", organizationId)
    .eq("address", address)
    .eq("key", key)
    .maybeSingle();

  if (data?.value) return data.value;

  // Fallback: read from extra (backwards compatibility for unmigrated instances)
  const { data: addr } = await client
    .from("organizations_addresses")
    .select("extra")
    .eq("organization_id", organizationId)
    .eq("address", address)
    .maybeSingle();

  const extra = addr?.extra as Record<string, string> | null;
  return extra?.[key] || null;
}

/**
 * Set a secret for an organization address.
 */
export async function setSecret(
  client: SupabaseClient<Database>,
  organizationId: string,
  address: string,
  key: string,
  value: string,
): Promise<void> {
  await client
    .from("organization_secrets")
    .upsert({
      organization_id: organizationId,
      address,
      key,
      value,
    })
    .throwOnError();
}

/**
 * Delete a secret for an organization address.
 */
export async function deleteSecret(
  client: SupabaseClient<Database>,
  organizationId: string,
  address: string,
  key: string,
): Promise<void> {
  await client
    .from("organization_secrets")
    .delete()
    .eq("organization_id", organizationId)
    .eq("address", address)
    .eq("key", key);
}
