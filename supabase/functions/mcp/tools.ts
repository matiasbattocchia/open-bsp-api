import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, IncomingStatus, OutgoingStatus, OutgoingMessage, MessageRow, TemplateData } from "../_shared/supabase.ts";
import dayjs from "dayjs";
import { listTemplates as listTemplatesMethod, fetchTemplate as fetchTemplateMethod } from "../whatsapp-management/templates.ts";

// Helper: Normalize phone number to digits only
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

// Helper: Format time to WhatsApp style
function formatTime(timestamp: string): string {
  const dayjsTs = dayjs(timestamp);
  const now = dayjs();

  // Difference in calendar days
  const diffDays = now.startOf('day').diff(dayjsTs.startOf('day'), 'day');

  if (diffDays === 0) return dayjsTs.format("HH:mm");
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return dayjsTs.format("dddd"); // e.g. Thursday

  return dayjsTs.format("YYYY-MM-DD");
}

// Helper: Format status to the most recent status name
function formatStatus(status: IncomingStatus | OutgoingStatus): keyof (IncomingStatus & OutgoingStatus) {
  const entries = Object.entries(status);
  const validEntries = entries.filter((entry): entry is [string, string] => {
    const [k, v] = entry;
    return k !== "errors" && typeof v === "string";
  });

  const sorted = validEntries.sort(([_ak, av], [_bk, bv]) => new Date(av).getTime() - new Date(bv).getTime());
  const last = sorted[sorted.length - 1];

  // Default to 'pending' if no status found, though technically should allow undefined if status is empty
  return (last ? last[0] : "pending") as keyof (IncomingStatus & OutgoingStatus);
}

// Helper: Count unread messages.
// Note: messages are sorted by timestamp descending
function countUnread(messages: MessageRow[] | undefined | null): number {
  if (!messages) { return 0; }

  const index = messages.findIndex((m) => m.direction === "outgoing")

  if (index === -1) { return 0; }

  return index;
}

interface ResolveAccountParams {
  supabase: SupabaseClient<Database>;
  orgId: string;
  accountPhone?: string;
  allowedAccounts: string[];
}

/**
 * Resolves a WhatsApp account for the organization, applying allowedAccounts filter.
 */
async function resolveAccount(params: ResolveAccountParams) {
  const accountPhone = params.accountPhone;
  const allowedAccounts = params.allowedAccounts;

  let query = params.supabase
    .from("organizations_addresses")
    .select("address, phone:extra->>phone_number, name:extra->>verified_name")
    .eq("organization_id", params.orgId)
    .eq("service", "whatsapp")
    .eq("status", "connected");

  if (allowedAccounts.length) {
    query = query.in("extra->>'phone_number'", allowedAccounts);
  }

  const { data: accounts } = await query.throwOnError();

  if (!accounts.length) {
    throw new Error("No connected WhatsApp accounts found for this organization.");
  }

  const availablePhones = accounts.map((a) => `${a.name} (${a.phone})`).join(", ");

  if (accountPhone) {
    const found = accounts.find((a) => a.phone === accountPhone);

    if (!found) {
      if (allowedAccounts.length) {
        throw new Error(`Account phone ${accountPhone} not found in allowed accounts. Allowed accounts: ${allowedAccounts.join(", ")}`);
      } else {
        throw new Error(`Account phone ${accountPhone} not found in available accounts. Available accounts: ${availablePhones}`);
      }
    }

    return found;
  }

  // No account provided
  if (accounts.length > 1) {
    throw new Error(
      `Multiple accounts found. Please specify account_phone. Available accounts: ${availablePhones}`
    );
  }

  return accounts[0];
}

interface ListConversationsParams {
  supabase: SupabaseClient<Database>;
  orgId: string;
  limit?: number;
  allowedAccounts: string[];
  allowedContacts: string[];
  accountPhone?: string;
}

export async function listConversations(params: ListConversationsParams) {
  const accountPhone = params.accountPhone ? normalizePhone(params.accountPhone) : undefined;
  const allowedAccounts = params.allowedAccounts;
  const allowedContacts = params.allowedContacts;
  const limit = params.limit || 10;

  const account = await resolveAccount({
    supabase: params.supabase,
    orgId: params.orgId,
    accountPhone,
    allowedAccounts
  });

  // Query 1: Get recent messages to find active conversation IDs
  // Fetch enough messages to likely cover `limit` unique conversations
  let recentQuery = params.supabase
    .from("messages")
    .select("conversation_id")
    .eq("organization_id", params.orgId)
    .eq("organization_address", account.address)
    .eq("service", "whatsapp")
    .order("timestamp", { ascending: false })
    .limit(limit * 20); // Fetch extra to account for multiple messages per conversation

  if (allowedContacts.length) {
    recentQuery = recentQuery.in("contact_address", allowedContacts);
  }

  const { data: recentMessages } = await recentQuery.throwOnError();

  // Dedupe conversation IDs preserving order (most recent first)
  const conversationIds = [...new Set((recentMessages || []).map((m) => m.conversation_id))].slice(0, limit);

  if (conversationIds.length === 0) {
    return {
      account: { name: account.name, phone: account.address },
      conversations: []
    };
  }

  // Query 2: Fetch full conversation data for the selected IDs
  const { data: conversations } = await params.supabase
    .from("conversations")
    .select(`
      *,
      messages(*),
      contact_address:contacts_addresses(*, contact:contacts(*))
    `)
    .in("id", conversationIds)
    .eq("status", "active")
    .order("timestamp", { referencedTable: "messages", ascending: false })
    .limit(10, { referencedTable: "messages" })
    .throwOnError();

  // Sort by the original order from query 1
  const idOrder = new Map(conversationIds.map((id, i) => [id, i]));
  const sortedConversations = conversations.sort(
    (a, b) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999)
  );

  return {
    account: {
      name: account.name,
      phone: account.address,
    },
    conversations: sortedConversations.map((c) => ({
      contact: {
        name: c.contact_address?.contact?.name || c.contact_address?.extra?.name || "Unknown",
        phone: c.contact_address?.address
      },
      unread: countUnread(c.messages),
      last_message: c.messages?.length ? {
        direction: c.messages[0].direction,
        content: c.messages[0].content,
        timestamp: formatTime(c.messages[0].timestamp),
        status: formatStatus(c.messages[0].status)
      } : null
    }))
  };
}

interface FetchConversationParams {
  supabase: SupabaseClient<Database>;
  orgId: string;
  contactPhone: string;
  limit?: number;
  allowedAccounts: string[];
  allowedContacts: string[];
  accountPhone?: string;
}

export async function fetchConversation(params: FetchConversationParams) {
  const contactPhone = normalizePhone(params.contactPhone);
  const accountPhone = params.accountPhone ? normalizePhone(params.accountPhone) : undefined;
  const allowedAccounts = params.allowedAccounts;
  const allowedContacts = params.allowedContacts;

  if (allowedContacts.length && !allowedContacts.includes(contactPhone)) {
    throw new Error(`Contact ${contactPhone} is not allowed. Allowed contacts: ${allowedContacts.join(", ")}`);
  }

  const account = await resolveAccount({
    supabase: params.supabase,
    orgId: params.orgId,
    accountPhone,
    allowedAccounts
  });

  const { data: conversation } = await params.supabase
    .from("conversations")
    .select(`
      *,
      messages(direction, content, timestamp, status),
      contacts_addresses(*, contacts(*))
    `)
    .eq("organization_id", params.orgId)
    .eq("contact_address", contactPhone)
    .eq("organization_address", account.address)
    .eq("service", "whatsapp")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .order("timestamp", { ascending: false, referencedTable: "messages" })
    .limit(1)
    .limit(params.limit || 10, { referencedTable: "messages" })
    .maybeSingle()
    .throwOnError();

  if (!conversation) {
    throw new Error(`Conversation with contact ${contactPhone} not found`);
  }

  // Service Window Logic
  const lastIncoming = conversation.messages?.findLast(m => m.direction === 'incoming')

  let serviceWindow = "closed";

  if (lastIncoming) {
    const diffHours = dayjs().diff(dayjs(lastIncoming.timestamp), 'hour');

    if (diffHours < 24) { serviceWindow = "open" };
  }

  const lightweightMessages = conversation.messages?.toReversed().map(m => {
    if ("task" in m.content) {
      delete m.content.task;
    }

    if ("tool" in m.content) {
      delete m.content.tool;
    }

    return {
      direction: m.direction,
      content: m.content,
      time: formatTime(m.timestamp),
      status: formatStatus(m.status),
      ...("errors" in m.status && { errors: m.status.errors })
    };
  });

  return {
    account: { name: account.name, phone: account.phone },
    contact: { name: conversation.contacts_addresses?.contacts?.name || conversation.contacts_addresses?.extra?.name, phone: contactPhone },
    service_window: serviceWindow,
    messages: lightweightMessages
  };
}

interface SearchContactsParams {
  supabase: SupabaseClient<Database>;
  orgId: string;
  name?: string;
  number?: string;
  allowedContacts: string[];
}

export async function searchContacts(params: SearchContactsParams) {
  const number = params.number ? normalizePhone(params.number) : undefined;
  const allowedContacts = params.allowedContacts;

  if (!params.name && !number) {
    throw new Error("One of 'name' or 'number' is required");
  }

  const select = params.name
    ? "phone:address, contact:contacts!inner(name)"
    : "phone:address, contact:contacts(name)";

  let query = params.supabase
    .from("contacts_addresses")
    .select(select)
    .eq("organization_id", params.orgId)
    .eq("service", "whatsapp")
    .eq("status", "active");

  if (allowedContacts.length) {
    query = query.in("address", allowedContacts);
  }

  if (number) {
    query = query.like("address", `%${number}%`);
  }

  if (params.name) {
    query = query.ilike("contacts.name", `%${params.name}%`);
  }

  const { data: contacts } = await query.throwOnError();

  return { contacts: contacts.map(c => ({ name: c.contact?.name, phone: c.phone })) };
}

interface ListAccountsParams {
  supabase: SupabaseClient<Database>;
  orgId: string;
  allowedAccounts: string[];
}

export async function listAccounts(params: ListAccountsParams) {
  const allowedAccounts = params.allowedAccounts;

  let query = params.supabase
    .from("organizations_addresses")
    .select("phone:extra->>phone_number, name:extra->>verified_name")
    .eq("organization_id", params.orgId)
    .eq("service", "whatsapp")
    .eq("status", "connected");

  if (allowedAccounts.length) {
    query = query.in("extra->>phone_number", allowedAccounts);
  }

  const { data: accounts } = await query.throwOnError();

  return { accounts };
}

interface SendMessageParams {
  supabase: SupabaseClient<Database>;
  orgId: string;
  content: OutgoingMessage;
  contactPhone: string;
  accountPhone?: string;
  allowedAccounts: string[];
  allowedContacts: string[];
}

export async function sendMessage(params: SendMessageParams) {
  const contactPhone = normalizePhone(params.contactPhone);
  const accountPhone = params.accountPhone ? normalizePhone(params.accountPhone) : undefined;
  const allowedAccounts = params.allowedAccounts;
  const allowedContacts = params.allowedContacts;

  if (allowedContacts.length && !allowedContacts.includes(contactPhone)) {
    throw new Error(`Contact ${contactPhone} not allowed. Allowed contacts: ${allowedContacts.join(", ")}`);
  }

  const account = await resolveAccount({
    supabase: params.supabase,
    orgId: params.orgId,
    accountPhone,
    allowedAccounts
  });

  // Check service window if type is text
  if (params.content.kind !== 'template') {
    const { data: lastMsg } = await params.supabase
      .from("messages")
      .select("timestamp")
      .eq("organization_id", params.orgId)
      .eq("organization_address", account.address)
      .eq("contact_address", contactPhone)
      .eq("direction", "incoming")
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastMsg) {
      throw new Error("Service window is closed (no prior incoming message). You must send a template content to open the service window.");
    }

    const diff = dayjs().diff(dayjs(lastMsg.timestamp), 'hour');

    if (diff >= 24) {
      throw new Error("Service window is closed (24h+ since last user message). You must send a template content to re-open it.");
    }
  }

  // Validate content type is actively supported for sending via this tool
  const isSupported =
    (params.content.type === 'text') ||
    (params.content.type === 'data' && params.content.kind === 'template');

  if (!isSupported) {
    throw new Error("Unsupported content type. Only 'text' and 'template' (data/kind=template) are supported.");
  }

  await params.supabase
    .from("messages")
    .insert({
      organization_id: params.orgId,
      organization_address: account.address,
      contact_address: contactPhone,
      service: "whatsapp",
      direction: "outgoing",
      content: params.content,
    })
    .throwOnError();

  return { status: "sent" };
}

interface ListTemplatesParams {
  supabase: SupabaseClient<Database>;
  orgId: string;
  accountPhone?: string;
  allowedAccounts: string[];
}

export async function listTemplates(params: ListTemplatesParams) {
  const accountPhone = params.accountPhone ? normalizePhone(params.accountPhone) : undefined;
  const allowedAccounts = params.allowedAccounts;

  const account = await resolveAccount({
    supabase: params.supabase,
    orgId: params.orgId,
    accountPhone,
    allowedAccounts
  });

  const templates = await listTemplatesMethod(params.supabase, params.orgId, account.address);

  return {
    templates: templates.map((t: TemplateData) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      category: t.category,
      language: t.language
    }))
  };
}

interface FetchTemplateDetailsParams {
  supabase: SupabaseClient<Database>;
  orgId: string;
  templateId: string;
  accountPhone?: string;
  allowedAccounts: string[];
}

export async function fetchTemplate(params: FetchTemplateDetailsParams) {
  const accountPhone = params.accountPhone ? normalizePhone(params.accountPhone) : undefined;
  const allowedAccounts = params.allowedAccounts;

  const account = await resolveAccount({
    supabase: params.supabase,
    orgId: params.orgId,
    accountPhone,
    allowedAccounts
  });

  const t = await fetchTemplateMethod(params.supabase, params.orgId, account.address, { id: params.templateId } as TemplateData);

  return {
    id: t.id,
    name: t.name,
    status: t.status,
    category: t.category,
    language: t.language,
    components: t.components
  };
}
