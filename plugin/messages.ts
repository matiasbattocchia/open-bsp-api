/**
 * Inbound messages: who may reach Claude, and how a message reads.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "./config.ts";
import type { ConversationRow, MessageContent, MessageRow } from "./types.ts";

// ── Access control ──────────────────────────────────────────────────────

// A phone number written any way: +54 9 11 5555-1234, 5491155551234.
const PHONE = /^\+?[\d\s().-]+$/;

/** How an allowlist entry is stored: a phone as its digits, else verbatim. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  return PHONE.test(trimmed) ? trimmed.replace(/\D/g, "") : trimmed;
}

export function sameAddress(entry: string, address: string): boolean {
  if (entry === address) return true;
  // Phones match on their digits; every other address (an Instagram or
  // TikTok id, a Slack user or channel id, a WhatsApp group JID) verbatim.
  return PHONE.test(entry) && PHONE.test(address) &&
    entry.replace(/\D/g, "") === address.replace(/\D/g, "");
}

/**
 * Whether a message reaches Claude: its author, or the conversation it was
 * written in, is on the allowlist. An allowed conversation forwards everyone
 * in it; an allowed person is forwarded wherever they write.
 */
export function isAllowed(addresses: (string | null)[]): boolean {
  const { allowedContacts } = loadConfig();
  // Empty list = no contacts allowed (secure by default)
  return addresses.some((address) =>
    address !== null &&
    allowedContacts.some((entry) => sameAddress(entry, address))
  );
}

// ── Name resolution ─────────────────────────────────────────────────────

// Cache names to avoid repeated queries
export type ContactName = {
  name: string;
  // From the account's address book (synced), not the name the contact set
  // for themself: a stranger can call themself anything.
  saved: boolean;
};

const contactCache = new Map<string, ContactName>();
const conversationCache = new Map<
  string,
  Pick<ConversationRow, "address" | "name" | "type">
>();

export async function resolveContact(
  supabase: SupabaseClient,
  msg: Pick<
    MessageRow,
    "service" | "organization_id" | "organization_address"
  >,
  address: string,
): Promise<ContactName> {
  const key = `${msg.service}:${msg.organization_address}:${address}`;
  const cached = contactCache.get(key);
  if (cached) return cached;

  // The entry in this connection's address book: the saved name wins over
  // the one the contact set for themself (push name, profile).
  const { data } = await supabase
    .from("contacts_addresses")
    .select("extra")
    .eq("organization_id", msg.organization_id)
    .eq("organization_address", msg.organization_address)
    .eq("service", msg.service)
    .eq("address", address)
    .maybeSingle();

  const saved = data?.extra?.synced?.name;
  const contact = {
    name: saved ?? data?.extra?.name ?? data?.extra?.username ?? address,
    saved: !!saved,
  };
  contactCache.set(key, contact);
  return contact;
}

export async function resolveContactName(
  supabase: SupabaseClient,
  msg: MessageRow,
  address: string,
): Promise<string> {
  return (await resolveContact(supabase, msg, address)).name;
}

export async function resolveConversation(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<Pick<ConversationRow, "address" | "name" | "type"> | null> {
  const cached = conversationCache.get(conversationId);
  if (cached) return cached;

  const { data } = await supabase
    .from("conversations")
    .select("address, name, type")
    .eq("id", conversationId)
    .maybeSingle();

  if (data) conversationCache.set(conversationId, data);
  return data;
}

// ── Message content formatting ──────────────────────────────────────────

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** What a file or message carries besides itself: a transcription, a description. */
function artifacts(content: MessageContent): string {
  return (content.artifacts ?? [])
    .filter((a) => a.type === "text" && a.text)
    .map((a) => ` [${a.kind}: ${(a as { text: string }).text}]`)
    .join("");
}

/** A template as sent: its name and the values filled into it. */
function template(data: Record<string, unknown>): string {
  const components = (data.components ?? []) as {
    parameters?: { type: string; text?: string }[];
  }[];
  const values = components
    .flatMap((c) => c.parameters ?? [])
    .map((p) => p.text)
    .filter(Boolean);
  return `(template ${data.name}${
    values.length ? `: ${values.join(" | ")}` : ""
  })`;
}

export function formatMessageContent(content: MessageContent): string {
  if (!content) return "(empty)";
  return formatPart(content) + artifacts(content);
}

function formatPart(content: MessageContent): string {
  switch (content.type) {
    case "text":
      return content.kind === "reaction"
        ? `(reaction: ${content.text})`
        : content.text ?? "(empty text)";
    case "file": {
      const name = content.file?.name ?? content.kind ?? "file";
      return content.text
        ? `[${content.kind}: ${name}] ${content.text}`
        : `(${content.kind}: ${name})`;
    }
    case "data": {
      const data = (content.data ?? {}) as Record<string, unknown>;
      switch (content.kind) {
        case "location":
          return `(location: ${
            [data.name, data.address].filter(Boolean).join(", ") ||
            `${data.latitude}, ${data.longitude}`
          })`;
        case "contacts":
          return `(contacts: ${clip(JSON.stringify(content.data), 300)})`;
        case "reaction":
          return data.action === "removed"
            ? "(reaction removed)"
            : `(reaction: ${data.unicode ?? `:${data.name}:`})`;
        case "share":
          return `(shared ${data.type}: ${data.url})${
            data.title ? ` ${data.title}` : ""
          }`;
        case "poll":
          return `(poll: ${data.question} — ${
            ((data.options ?? []) as string[]).join(" / ")
          })`;
        case "poll_vote":
          return `(poll vote on "${data.question}": ${
            ((data.selected ?? []) as string[]).join(", ") || "withdrawn"
          })`;
        case "template":
          return template(data);
        default:
          return content.text ?? `(${content.kind})`;
      }
    }
    default:
      return `(${(content as { type?: string }).type ?? "unknown"} message)`;
  }
}

/** Whether a message is only a reaction: nothing to answer. */
export function isReaction(content: MessageContent): boolean {
  return content?.kind === "reaction";
}
