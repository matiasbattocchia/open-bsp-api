import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../_shared/supabase.ts";

// Helper: Normalize phone number to digits only
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Resolves a WhatsApp account for the organization.
 * 
 * Logic:
 * 1. Fetches all connected WhatsApp accounts for the org
 * 2. If accountPhone provided: validates it exists and returns that account
 * 3. If no accountPhone: returns the account only if there's exactly one
 * 
 * @throws Error if no accounts, account not found, or multiple accounts without specifying which one
 */
async function resolveAccount(
  supabase: SupabaseClient<Database>,
  orgId: string,
  accountPhone?: string
) {
  // Fetch all connected accounts for this org
  const { data: accounts } = await supabase
    .from("organizations_addresses")
    .select()
    .eq("organization_id", orgId)
    .eq("service", "whatsapp")
    .eq("status", "connected")
    .throwOnError()

  if (accounts.length === 0) {
    throw new Error("No connected WhatsApp accounts found for this organization");
  }

  // Transform to Account type
  const accountList = accounts.map((oa) => ({
    address: oa.address,
    phone: oa.extra?.phone_number,
    name: oa.extra?.verified_name
  }));

  if (accountPhone) {
    // Validate the provided account phone exists
    const normalized = normalizePhone(accountPhone);
    const found = accountList.find((a) => a.phone === normalized);

    if (!found) {
      const availablePhones = accountList.map((a) => a.phone).join(", ");

      throw new Error(
        `Account phone ${accountPhone} not found. Available accounts: ${availablePhones}`
      );
    }

    return found;
  }

  // No account phone provided - must have exactly one account
  if (accountList.length > 1) {
    const availablePhones = accountList.map((a) => `${a.name} (${a.phone})`).join(", ");

    throw new Error(
      `Multiple accounts found. Please specify account_phone. Available: ${availablePhones}`
    );
  }

  return accountList[0];
}

export async function listConversations(
  supabase: SupabaseClient<Database>,
  orgId: string,
  limit: number = 10
) {
  // Use RPC for complex nested JSON query
  const { data, error } = await supabase.rpc("mcp_list_conversations", {
    p_org_id: orgId,
    p_limit: limit,
  });

  if (error) throw error;
  // Unwrap the JSONB wrapper - RPC returns {conversation: {...}} objects
  type ConversationRow = { conversation: Record<string, unknown> };
  return (data as ConversationRow[]).map((d) => d.conversation);
}

export async function getConversation(
  supabase: SupabaseClient<Database>,
  orgId: string,
  contactPhone: string,
  limit: number = 10,
  accountPhone?: string
) {
  const contactAddress = normalizePhone(contactPhone);

  const { address: organizationAddress } = await resolveAccount(supabase, orgId, accountPhone);

  const { data } = await supabase
    .from("messages")
    .select(`
      direction,
      content,
      timestamp,
      status,
      conversations!inner(organization_id, contact_address, organization_address, service, status)
    `)
    .eq("conversations.organization_id", orgId)
    .eq("conversations.contact_address", contactAddress)
    .eq("conversations.organization_address", organizationAddress)
    .eq("conversations.service", "whatsapp")
    .eq("conversations.status", "active")
    .order("timestamp", { ascending: false })
    .limit(limit)
    .throwOnError();

  // Format response - extract reduced content (file, data, or text)
  const messages = data.map((m) => {
    // Get most recent status key (status values are timestamps)
    const status = Object.entries(m.status)
      // deno-lint-ignore no-explicit-any
      .sort((a: any, b: any) => new Date(b[1]).getTime() - new Date(a[1]).getTime())
      .at(0)
      ?.at(0);

    // deno-lint-ignore no-explicit-any
    const content = { ...m.content } as any;
    delete content.type;
    delete content.version;
    delete content.task;
    delete content.tool;
    delete content.artifacts;

    return {
      direction: m.direction,
      content,
      timestamp: m.timestamp,
      status,
      ...("errors" in m.status && { errors: m.status.errors }),
    };
  });

  return { messages };
}

export async function searchContacts(
  supabase: SupabaseClient<Database>,
  orgId: string,
  name?: string,
  number?: string
) {
  if (!name && !number) {
    throw new Error("One of 'name' or 'number' is required");
  }

  // Since there's no FK relationship between contacts_addresses and contacts
  // (relationship is via JSONB containment), we need separate queries:

  if (name) {
    // Search by name: query contacts table, then extract addresses from extra.addresses
    const { data: contacts } = await supabase
      .from("contacts")
      .select("name, extra")
      .eq("organization_id", orgId)
      .ilike("name", `%${name}%`)
      .throwOnError()

    // Extract addresses from contacts.extra.addresses array
    type ContactRow = { name: string | null; extra: { addresses?: string[] } | null };
    const results = (contacts as ContactRow[] || []).flatMap((c) => {
      const addresses = c.extra?.addresses || [];
      return addresses.map((addr: string) => ({
        name: c.name || "Unknown",
        phone: addr,
      }));
    });

    // Deduplicate by phone
    const seen = new Set<string>();
    return results.filter((r) => {
      if (seen.has(r.phone)) return false;
      seen.add(r.phone);
      return true;
    });
  } else {
    // Search by number: query contacts_addresses table
    const normalizedNumber = normalizePhone(number!);

    const { data: addresses } = await supabase
      .from("contacts_addresses")
      .select("address, extra")
      .eq("organization_id", orgId)
      .eq("service", "whatsapp")
      .eq("status", "active")
      .ilike("address", `%${normalizedNumber}%`)
      .throwOnError()

    // Format results using name from extra if available
    type AddressRow = { address: string; extra: { name?: string } | null };
    const results = (addresses as AddressRow[] || []).map((ca) => ({
      name: ca.extra?.name || "Unknown",
      phone: ca.address,
    }));

    // Deduplicate by phone
    const seen = new Set<string>();
    return results.filter((r) => {
      if (seen.has(r.phone)) return false;
      seen.add(r.phone);
      return true;
    });
  }
}

export async function listAccounts(
  supabase: SupabaseClient<Database>,
  orgId: string
) {
  // Fetch all connected accounts for this org
  const { data: accounts } = await supabase
    .from("organizations_addresses")
    .select()
    .eq("organization_id", orgId)
    .eq("service", "whatsapp")
    .eq("status", "connected")
    .throwOnError()

  // Transform to Account type
  const accountList = accounts.map((oa) => ({
    phone: oa.extra?.phone_number,
    name: oa.extra?.verified_name
  }));

  return accountList
}

export async function sendMessage(
  supabase: SupabaseClient<Database>,
  orgId: string,
  contactPhone: string,
  text: string,
  accountPhone?: string
) {
  const contactAddress = normalizePhone(contactPhone);

  const { address: organizationAddress } = await resolveAccount(supabase, orgId, accountPhone);

  await supabase
    .from("messages")
    .insert({
      organization_id: orgId,
      organization_address: organizationAddress,
      contact_address: contactAddress,
      service: "whatsapp",
      direction: "outgoing",
      content: { version: "1", type: "text", kind: "text", text },
    })
    .throwOnError();

  return { status: "ok" };
}
