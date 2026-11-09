import type { SupabaseClient } from "@supabase/supabase-js";
import { contactName } from "../_shared/supabase.ts";
import type {
  Database,
  IncomingStatus,
  MessageRow,
  OutgoingMessage,
  OutgoingStatus,
  TemplateData,
} from "../_shared/supabase.ts";
import dayjs from "dayjs";
import {
  fetchTemplate as fetchTemplateMethod,
  listTemplates as listTemplatesMethod,
} from "../whatsapp-management/templates.ts";

// Helper: Normalize phone number to digits only
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

// Helper: Format time to WhatsApp style
function formatTime(timestamp: string): string {
  const dayjsTs = dayjs(timestamp);
  const now = dayjs();

  // Difference in calendar days
  const diffDays = now.startOf("day").diff(dayjsTs.startOf("day"), "day");

  if (diffDays === 0) return dayjsTs.format("HH:mm");
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return dayjsTs.format("dddd"); // e.g. Thursday

  return dayjsTs.format("YYYY-MM-DD");
}

// Helper: Format status to the most recent status name
function formatStatus(
  status: IncomingStatus | OutgoingStatus,
): keyof (IncomingStatus & OutgoingStatus) {
  const entries = Object.entries(status);
  const validEntries = entries.filter((entry): entry is [string, string] => {
    const [k, v] = entry;
    return k !== "errors" && typeof v === "string";
  });

  const sorted = validEntries.sort(([_ak, av], [_bk, bv]) =>
    new Date(av).getTime() - new Date(bv).getTime()
  );
  const last = sorted[sorted.length - 1];

  // Default to 'pending' if no status found, though technically should allow undefined if status is empty
  return (last ? last[0] : "pending") as keyof (
    & IncomingStatus
    & OutgoingStatus
  );
}

// Helper: Count unread messages
// Note: messages are sorted by timestamp descending
function countUnread(messages: MessageRow[] | undefined | null): number {
  if (!messages) return 0;

  // Unread = contact-authored messages since our last send (sender null = us).
  const index = messages.findIndex((m) => m.sender_address === null);

  if (index === -1) return 0;

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
    throw new Error(
      "No connected WhatsApp accounts found for this organization.",
    );
  }

  const availablePhones = accounts.map((a) => `${a.name} (${a.phone})`).join(
    ", ",
  );

  if (accountPhone) {
    const found = accounts.find((a) => a.phone === accountPhone);

    if (!found) {
      if (allowedAccounts.length) {
        throw new Error(
          `Account phone ${accountPhone} not found in allowed accounts. Allowed accounts: ${
            allowedAccounts.join(", ")
          }`,
        );
      } else {
        throw new Error(
          `Account phone ${accountPhone} not found in available accounts. Available accounts: ${availablePhones}`,
        );
      }
    }

    return found;
  }

  // No account provided
  if (accounts.length > 1) {
    throw new Error(
      `Multiple accounts found. Please specify account_phone. Available accounts: ${availablePhones}`,
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
  const accountPhone = params.accountPhone
    ? normalizePhone(params.accountPhone)
    : undefined;
  const allowedAccounts = params.allowedAccounts;
  const allowedContacts = params.allowedContacts;
  const limit = params.limit || 10;

  const account = await resolveAccount({
    supabase: params.supabase,
    orgId: params.orgId,
    accountPhone,
    allowedAccounts,
  });

  // Query 1: Get recent messages to find active conversation IDs
  // Fetch enough messages to likely cover `limit` unique conversations
  let recentQuery = params.supabase
    .from("messages")
    .select("conversation_id")
    .eq("organization_id", params.orgId)
    .eq("organization_address", account.address)
    .eq("service", "whatsapp")
    .is("content->internal", null) // record-only rows are not conversation
    .order("timestamp", { ascending: false })
    .limit(limit * 20); // Fetch extra to account for multiple messages per conversation

  if (allowedContacts.length) {
    recentQuery = recentQuery.in("conversation_address", allowedContacts);
  }

  const { data: recentMessages } = await recentQuery.throwOnError();

  // Dedupe conversation IDs preserving order (most recent first)
  const conversationIds = [
    ...new Set((recentMessages || []).map((m) => m.conversation_id)),
  ].slice(0, limit);

  if (conversationIds.length === 0) {
    return {
      account: { name: account.name, phone: account.phone },
      conversations: [],
    };
  }

  // Query 2: Fetch full conversation data for the selected IDs. The contact
  // comes from its own query below — the conversation's address is a soft
  // reference, so there is no FK for PostgREST to embed through.
  const { data: conversations } = await params.supabase
    .from("conversations")
    .select(`
      *,
      messages(*)
    `)
    .in("id", conversationIds)
    .is("messages.content->internal", null)
    .order("timestamp", { referencedTable: "messages", ascending: false })
    .limit(10, { referencedTable: "messages" })
    .throwOnError();

  const { data: contactRows } = await params.supabase
    .from("contacts_addresses")
    .select("*")
    .eq("organization_id", params.orgId)
    .eq("organization_address", account.address)
    .eq("service", "whatsapp")
    .in(
      "address",
      conversations.map((c) => c.address),
    )
    .throwOnError();

  const contactByAddress = new Map(contactRows.map((r) => [r.address, r]));

  // Sort by the original order from query 1
  const idOrder = new Map(conversationIds.map((id, i) => [id, i]));
  const sortedConversations = conversations.sort(
    (a, b) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999),
  );

  return {
    account: {
      name: account.name,
      phone: account.phone,
    },
    conversations: sortedConversations.map((c) => {
      const contactAddress = contactByAddress.get(c.address);

      return {
        contact: {
          name: contactName(contactAddress?.extra) || "Unknown",
          phone: c.address,
        },
        unread: countUnread(c.messages),
        last_message: c.messages?.length
          ? {
            from: c.messages[0].sender_address ? "contact" : "organization",
            content: c.messages[0].content,
            timestamp: formatTime(c.messages[0].timestamp),
            status: formatStatus(c.messages[0].status),
          }
          : null,
      };
    }),
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
  const accountPhone = params.accountPhone
    ? normalizePhone(params.accountPhone)
    : undefined;
  const allowedAccounts = params.allowedAccounts;
  const allowedContacts = params.allowedContacts;

  if (allowedContacts.length && !allowedContacts.includes(contactPhone)) {
    throw new Error(
      `Contact ${contactPhone} is not allowed. Allowed contacts: ${
        allowedContacts.join(", ")
      }`,
    );
  }

  const account = await resolveAccount({
    supabase: params.supabase,
    orgId: params.orgId,
    accountPhone,
    allowedAccounts,
  });

  const { data: conversation } = await params.supabase
    .from("conversations")
    .select(`
      *,
      messages(sender_address, content, timestamp, status)
    `)
    .eq("organization_id", params.orgId)
    .eq("address", contactPhone)
    .eq("organization_address", account.address)
    .eq("service", "whatsapp")
    .is("messages.content->internal", null)
    .order("created_at", { ascending: false })
    .order("timestamp", { ascending: false, referencedTable: "messages" })
    .limit(1)
    .limit(params.limit || 10, { referencedTable: "messages" })
    .maybeSingle()
    .throwOnError();

  if (!conversation) {
    throw new Error(`Conversation with contact ${contactPhone} not found`);
  }

  // The contact rides its own query (soft reference, no FK to embed by).
  const { data: contactAddressRow } = await params.supabase
    .from("contacts_addresses")
    .select("*")
    .eq("organization_id", params.orgId)
    .eq("organization_address", account.address)
    .eq("service", "whatsapp")
    .eq("address", contactPhone)
    .maybeSingle()
    .throwOnError();

  // Service Window Logic
  // Note: uses only the fetched messages (limited by `limit` param),
  // so it may report "closed" if the last incoming is outside the window.
  const lastIncoming = conversation.messages?.findLast((m) =>
    m.sender_address !== null
  );

  let serviceWindow = "closed";

  if (lastIncoming) {
    const diffHours = dayjs().diff(dayjs(lastIncoming.timestamp), "hour");

    if (diffHours < 24) serviceWindow = "open";
  }

  const lightweightMessages = conversation.messages?.toReversed().map((m) => {
    if ("task" in m.content) {
      delete m.content.task;
    }

    if ("tool" in m.content) {
      delete m.content.tool;
    }

    return {
      from: m.sender_address ? "contact" : "organization",
      content: m.content,
      time: formatTime(m.timestamp),
      status: formatStatus(m.status),
      ...("errors" in m.status && { errors: m.status.errors }),
    };
  });

  return {
    account: { name: account.name, phone: account.phone },
    contact: {
      name: contactName(contactAddressRow?.extra),
      phone: contactPhone,
    },
    service_window: serviceWindow,
    messages: lightweightMessages,
  };
}

interface SearchContactsParams {
  supabase: SupabaseClient<Database>;
  orgId: string;
  name?: string;
  number?: string;
  limit?: number;
  allowedContacts: string[];
}

export async function searchContacts(params: SearchContactsParams) {
  const number = params.number ? normalizePhone(params.number) : undefined;
  const allowedContacts = params.allowedContacts;

  let query = params.supabase
    .from("contacts_addresses")
    .select("phone:address, extra")
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
    // Match both name sources (the saved address-book name and the push
    // name); the pattern is quoted so commas/parens in the term don't break
    // the or().
    const pattern = `"*${params.name.replaceAll('"', "")}*"`;
    query = query.or(
      `extra->synced->>name.ilike.${pattern},extra->>name.ilike.${pattern}`,
    );
  }

  const { data: contacts } = await query.limit(params.limit || 10)
    .throwOnError();

  // A contact known through several of the org's numbers is one row per
  // account — collapse to one result per phone.
  const byPhone = new Map(
    contacts.map((
      c,
    ) => [c.phone, { name: contactName(c.extra), phone: c.phone }]),
  );

  return { contacts: [...byPhone.values()] };
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
  const accountPhone = params.accountPhone
    ? normalizePhone(params.accountPhone)
    : undefined;
  const allowedAccounts = params.allowedAccounts;
  const allowedContacts = params.allowedContacts;

  if (allowedContacts.length && !allowedContacts.includes(contactPhone)) {
    throw new Error(
      `Contact ${contactPhone} not allowed. Allowed contacts: ${
        allowedContacts.join(", ")
      }`,
    );
  }

  const account = await resolveAccount({
    supabase: params.supabase,
    orgId: params.orgId,
    accountPhone,
    allowedAccounts,
  });

  // Check service window if type is text
  if (params.content.kind !== "template") {
    const { data: lastMsg } = await params.supabase
      .from("messages")
      .select("timestamp")
      .eq("organization_id", params.orgId)
      .eq("organization_address", account.address)
      .eq("conversation_address", contactPhone)
      .not("sender_address", "is", null)
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastMsg) {
      throw new Error(
        "Service window is closed (no prior incoming message). You must send a template content to open the service window.",
      );
    }

    const diff = dayjs().diff(dayjs(lastMsg.timestamp), "hour");

    if (diff >= 24) {
      throw new Error(
        "Service window is closed (24h+ since last user message). You must send a template content to re-open it.",
      );
    }
  }

  // Validate content type is actively supported for sending via this tool
  const isSupported = (params.content.type === "text") ||
    (params.content.type === "data" && params.content.kind === "template");

  if (!isSupported) {
    throw new Error(
      "Unsupported content type. Only 'text' and 'template' (data/kind=template) are supported.",
    );
  }

  await params.supabase
    .from("messages")
    .insert({
      organization_id: params.orgId,
      organization_address: account.address,
      conversation_address: contactPhone,
      service: "whatsapp",
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
  const accountPhone = params.accountPhone
    ? normalizePhone(params.accountPhone)
    : undefined;
  const allowedAccounts = params.allowedAccounts;

  const account = await resolveAccount({
    supabase: params.supabase,
    orgId: params.orgId,
    accountPhone,
    allowedAccounts,
  });

  const { data: templates } = await listTemplatesMethod(
    params.supabase,
    params.orgId,
    account.address,
  );

  return {
    templates: templates.map((t: TemplateData) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      category: t.category,
      language: t.language,
    })),
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
  const accountPhone = params.accountPhone
    ? normalizePhone(params.accountPhone)
    : undefined;
  const allowedAccounts = params.allowedAccounts;

  const account = await resolveAccount({
    supabase: params.supabase,
    orgId: params.orgId,
    accountPhone,
    allowedAccounts,
  });

  const t = await fetchTemplateMethod(
    params.supabase,
    params.orgId,
    account.address,
    { id: params.templateId } as TemplateData,
  );

  return {
    id: t.id,
    name: t.name,
    status: t.status,
    category: t.category,
    language: t.language,
    components: t.components,
  };
}
