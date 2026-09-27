import { encodeBase64 } from "jsr:@std/encoding/base64";
import type { SupabaseClient } from "@supabase/supabase-js";
import ky from "ky";
import * as log from "./logger.ts";
import { downloadFromStorage } from "./media.ts";
import type {
  ButtonsMessageData,
  Database,
  IncomingMessage,
  MessageRow,
  OrganizationRow,
  OutgoingMessage,
} from "./supabase.ts";
import { type MessageRowV0, toV1 } from "./messages-v0.ts";

export type LunaRecentMessagesPolicy = {
  hours: number;
  /** Floor of recent messages kept even when older than `hours`. */
  maxMessages: number;
  includeMedia: "batch_only" | "all_in_window";
};

/** Shared contact card for Luna batchParts / recentMessages (no vCard blob). */
export type LunaContact = {
  name: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  phones: Array<{
    phone: string;
    type?: string;
    waId?: string;
  }>;
};

export type LunaRecentMessage = {
  /** WhatsApp message id (WAMID), when known. */
  id?: string;
  /**
   * OpenBSP `messages.id` (same value returned from POST /rest/v1/messages).
   * Lets consumers join an outbound send to the later batch echo without
   * matching on body text.
   */
  openbspId: string;
  direction: "incoming" | "outgoing";
  timestamp: string;
  kind:
    | "text"
    | "image"
    | "audio"
    | "document"
    | "video"
    | "button"
    | "contacts"
    | "other";
  text?: string;
  /** Reply-button / list / template-button id when `kind` is `button`. */
  buttonId?: string;
  /** Shared WhatsApp contact cards when `kind` is `contacts`. */
  contacts?: LunaContact[];
  mimeType?: string;
  base64Data?: string | null;
  fileName?: string;
  /** WhatsApp message id (WAMID) this message replies to, when present. */
  replyToId?: string;
  /** True when the WhatsApp message was forwarded. */
  forwarded?: boolean;
};

export type LunaBatchPart = {
  id: string;
  kind: "text" | "image" | "audio" | "document" | "button" | "contacts";
  text?: string;
  /** Reply-button / list / template-button id when `kind` is `button`. */
  buttonId?: string;
  /** Shared WhatsApp contact cards when `kind` is `contacts`. */
  contacts?: LunaContact[];
  mimeType?: string;
  base64Data?: string;
  fileName?: string;
  /** WhatsApp message id (WAMID) this part replies to, when present. */
  replyToId?: string;
  /** True when the WhatsApp message was forwarded. */
  forwarded?: boolean;
};

export type LunaWhatsAppBatchPayload = {
  idempotencyKey: string;
  senderPhone: string;
  receivedAt: string;
  contextHours: number;
  contextMaxMessages: number;
  recentMessagesPolicy: LunaRecentMessagesPolicy;
  recentMessages: LunaRecentMessage[];
  batchParts: LunaBatchPart[];
};

export type LunaWhatsAppBatchRow =
  Database["public"]["Tables"]["luna_whatsapp_batches"]["Row"];

const DEFAULT_CONTEXT_HOURS = 3;
const DEFAULT_CONTEXT_MAX_MESSAGES = 20;
/** Forwarded messages often arrive with a follow-up in the same burst. */
export const FORWARDED_DEBOUNCE_SECONDS = 2;
/** Pull other inbound msgs with Meta timestamp within ± this of the batch. */
export const SIBLING_TIMESTAMP_WINDOW_MS = 1_000;
/**
 * Sibling candidates must also be recent inserts (or still in an open batch).
 * Stops re-absorbing old already-sent rows that share a Meta second after the
 * sent-batch lookback expires.
 */
export const SIBLING_CREATED_WITHIN_MS = 30_000;
/** Look back this far for `sent`/`flushing` batches when skipping delivered ids. */
export const RECENTLY_SENT_LOOKBACK_MS = 60_000;
const MAX_FLUSH_ATTEMPTS = 5;
const SUPPORTED_FILE_KINDS = new Set(["audio", "image", "document", "video"]);

/**
 * Debounce before flushing a Luna batch for this message.
 * - Forwarded: 2s so a same-burst follow-up can join the open batch.
 * - Everything else (incl. button/list taps): 0 — flush immediately.
 */
export function lunaWhatsAppBatchDebounceSecondsForMessage(
  message: MessageRow,
): number {
  const content = normalizeMessageRow(message).content as IncomingMessage;
  if (content.forwarded) return FORWARDED_DEBOUNCE_SECONDS;
  return 0;
}

export function lunaWhatsAppBatchContextHours(
  org?: OrganizationRow | null,
): number {
  const orgHours =
    (org?.extra as { luna_whatsapp_batch_context_hours?: number } | null)
      ?.luna_whatsapp_batch_context_hours;
  if (typeof orgHours === "number" && orgHours > 0) return orgHours;

  const raw = Deno.env.get("LUNA_WHATSAPP_BATCH_CONTEXT_HOURS");
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_CONTEXT_HOURS;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_HOURS;
}

export function lunaWhatsAppBatchContextMaxMessages(
  org?: OrganizationRow | null,
): number {
  const orgMax = (org?.extra as {
    luna_whatsapp_batch_context_max_messages?: number;
  } | null)?.luna_whatsapp_batch_context_max_messages;
  if (typeof orgMax === "number" && orgMax > 0) return orgMax;

  const raw = Deno.env.get("LUNA_WHATSAPP_BATCH_CONTEXT_MAX_MESSAGES");
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_CONTEXT_MAX_MESSAGES;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CONTEXT_MAX_MESSAGES;
}

export function normalizeSenderPhone(contactAddress: string): string {
  return contactAddress.replace(/\D/g, "");
}

function normalizeMessageRow(row: MessageRow): MessageRow {
  const content = row.content as { version?: string };
  if (content.version === "1") return row;
  const converted = toV1(row as unknown as MessageRowV0);
  if (!converted) return row;
  return converted;
}

function lunaKindFromFileMime(
  mimeType: string,
): "image" | "audio" | "document" | "video" | "other" {
  const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  // Documents: PDF/Office/etc, CSV and other text attachments WhatsApp sends
  // as documents (text/csv, text/plain, …).
  if (mime.startsWith("application/") || mime.startsWith("text/")) {
    return "document";
  }
  return "other";
}

/** Map a MIME type to a Luna batchParts file kind (not video/other). */
export function batchPartKindFromMime(
  mimeType: string,
): "image" | "audio" | "document" | null {
  const kind = lunaKindFromFileMime(mimeType);
  if (kind === "audio" || kind === "image" || kind === "document") return kind;
  return null;
}

/**
 * Resolve Luna batchParts file kind. Prefer OpenBSP's stored inbound
 * `content.kind === "document"` so text/csv etc. are not dropped by MIME alone.
 */
export function lunaBatchPartFileKind(
  contentKind: string,
  mimeType: string,
): "image" | "audio" | "document" | null {
  if (contentKind === "document") return "document";
  return batchPartKindFromMime(mimeType);
}

async function fileToBase64(
  client: SupabaseClient<Database>,
  uri: string,
): Promise<string | null> {
  if (!uri.startsWith("internal://media/")) return null;
  try {
    const blob = await downloadFromStorage(client, uri);
    const buffer = await blob.arrayBuffer();
    return encodeBase64(new Uint8Array(buffer));
  } catch (error) {
    log.warn("Failed to read media for Luna WhatsApp batch", {
      uri,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function replyToIdFromContent(
  content: IncomingMessage | OutgoingMessage,
): string | undefined {
  return content.re_message_id || undefined;
}

function lunaButtonTapFromContent(
  content: IncomingMessage,
): { buttonId: string; text: string } | null {
  if (content.type !== "data") return null;

  if (content.kind === "button") {
    const payload = content.data.payload?.trim() ?? "";
    const text = content.data.text?.trim() ?? "";
    if (!payload && !text) return null;
    return { buttonId: payload || text, text: text || payload };
  }

  if (content.kind === "interactive") {
    const data = content.data;
    if (data.type === "button_reply") {
      const buttonId = data.button_reply.id?.trim() ?? "";
      const text = data.button_reply.title?.trim() ?? "";
      if (!buttonId && !text) return null;
      return { buttonId: buttonId || text, text: text || buttonId };
    }
    if (data.type === "list_reply") {
      const buttonId = data.list_reply.id?.trim() ?? "";
      const text = data.list_reply.title?.trim() ?? "";
      if (!buttonId && !text) return null;
      return { buttonId: buttonId || text, text: text || buttonId };
    }
  }

  return null;
}

function lunaOutgoingButtonsText(data: ButtonsMessageData): string {
  const body = data.body?.trim() ?? "";
  const labels = (data.buttons ?? [])
    .map((button) => {
      if (button.type === "website") {
        const title = button.title?.trim() ?? "";
        const url = button.url?.trim() ?? "";
        if (!title && !url) return "";
        return url ? `${title || "Link"} (${url})` : title;
      }
      return button.title?.trim() ?? "";
    })
    .filter((title): title is string => Boolean(title));
  if (labels.length === 0) return body;
  const suffix = `[${labels.join(" / ")}]`;
  return body ? `${body}\n${suffix}` : suffix;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Normalize WhatsApp contact cards; drop vCard blobs (large / unused by Luna). */
export function lunaContactsFromContentData(
  data: unknown,
): LunaContact[] {
  if (!Array.isArray(data)) return [];

  const contacts: LunaContact[] = [];
  for (const item of data) {
    const row = asRecord(item);
    if (!row) continue;

    const nameObj = asRecord(row.name);
    const orgObj = asRecord(row.org);
    const formattedName = stringField(nameObj, "formatted_name");
    const firstName = stringField(nameObj, "first_name");
    const lastName = stringField(nameObj, "last_name");
    const company = stringField(orgObj, "company");

    const phones: LunaContact["phones"] = [];
    if (Array.isArray(row.phones)) {
      for (const phoneRow of row.phones) {
        const phoneObj = asRecord(phoneRow);
        const phone = stringField(phoneObj, "phone");
        if (!phone) continue;
        const type = stringField(phoneObj, "type");
        const waId = stringField(phoneObj, "wa_id");
        phones.push({
          phone,
          ...(type && { type }),
          ...(waId && { waId }),
        });
      }
    }

    const name = formattedName ||
      [firstName, lastName].filter(Boolean).join(" ") ||
      company ||
      phones[0]?.phone;
    if (!name) continue;

    contacts.push({
      name,
      ...(firstName && { firstName }),
      ...(lastName && { lastName }),
      ...(company && { company }),
      phones,
    });
  }
  return contacts;
}

export function lunaContactsText(contacts: LunaContact[]): string {
  const lines = contacts.map((contact) => {
    const phoneBits = contact.phones.map((p) => {
      const wa = p.waId ? ` (wa:${p.waId})` : "";
      return `${p.phone}${wa}`;
    });
    const company = contact.company ? ` @ ${contact.company}` : "";
    const phones = phoneBits.length ? ` — ${phoneBits.join(", ")}` : "";
    return `${contact.name}${company}${phones}`;
  });
  return [`[אנשי קשר]`, ...lines].join("\n");
}

function lunaContextFields(content: IncomingMessage | OutgoingMessage): {
  replyToId?: string;
  forwarded?: boolean;
} {
  const replyToId = replyToIdFromContent(content);
  return {
    ...(replyToId && { replyToId }),
    ...(content.forwarded && { forwarded: true as const }),
  };
}

function collectReplyToIds(rows: MessageRow[]): Set<string> {
  const ids = new Set<string>();
  for (const message of rows) {
    const content = normalizeMessageRow(message).content as IncomingMessage;
    const replyToId = replyToIdFromContent(content);
    if (replyToId) ids.add(replyToId);
  }
  return ids;
}

async function messageToLunaRecent(
  client: SupabaseClient<Database>,
  message: MessageRow,
  opts: { includeMedia: boolean },
): Promise<LunaRecentMessage | null> {
  const row = normalizeMessageRow(message);
  const content = row.content as IncomingMessage | OutgoingMessage;
  const base = {
    ...(row.external_id ? { id: row.external_id } : {}),
    openbspId: row.id,
    direction: row.direction === "outgoing"
      ? "outgoing" as const
      : "incoming" as const,
    timestamp: row.timestamp,
    ...lunaContextFields(content),
  };

  if (content.type === "data" && content.kind === "flow-reply") {
    return null;
  }

  const tap = content.type === "data" && content.kind !== "buttons"
    ? lunaButtonTapFromContent(content as IncomingMessage)
    : null;
  if (tap) {
    return {
      ...base,
      kind: "button",
      text: tap.text,
      buttonId: tap.buttonId,
    };
  }

  if (content.type === "data" && content.kind === "buttons") {
    return {
      ...base,
      kind: "text",
      text: lunaOutgoingButtonsText(content.data),
    };
  }

  if (content.type === "data" && content.kind === "contacts") {
    const contacts = lunaContactsFromContentData(content.data);
    if (contacts.length === 0) return null;
    return {
      ...base,
      kind: "contacts",
      contacts,
      text: lunaContactsText(contacts),
    };
  }

  if (content.type === "text") {
    return {
      ...base,
      kind: "text",
      text: content.text,
    };
  }

  if (content.type === "file" && SUPPORTED_FILE_KINDS.has(content.kind)) {
    const mimeType = content.file.mime_type;
    // Prefer OpenBSP's stored file kind (e.g. WhatsApp document) over MIME guess.
    const kind = content.kind === "audio" || content.kind === "image" ||
        content.kind === "document" || content.kind === "video"
      ? content.kind
      : lunaKindFromFileMime(mimeType);
    let base64Data: string | null = null;
    if (opts.includeMedia) {
      base64Data = await fileToBase64(client, content.file.uri);
    }
    return {
      ...base,
      kind,
      text: content.text,
      mimeType,
      base64Data,
      fileName: content.file.name,
    };
  }

  return {
    ...base,
    kind: "other",
    text: content.type === "data" ? JSON.stringify(content.data) : undefined,
  };
}

async function messageToBatchPart(
  client: SupabaseClient<Database>,
  message: MessageRow,
): Promise<LunaBatchPart | LunaBatchPart[] | null> {
  const row = normalizeMessageRow(message);
  const content = row.content as IncomingMessage;
  // Luna requires batchParts[].id; skip rather than 422 when WhatsApp id is missing.
  if (!row.external_id) {
    log.warn("Skipping Luna batch part without external_id", {
      messageId: row.id,
    });
    return null;
  }
  const id = row.external_id;
  const contextFields = lunaContextFields(content);

  if (content.type === "text" && content.text?.trim()) {
    return { id, kind: "text", text: content.text.trim(), ...contextFields };
  }

  const tap = lunaButtonTapFromContent(content);
  if (tap) {
    return {
      id,
      kind: "button",
      text: tap.text,
      buttonId: tap.buttonId,
      ...contextFields,
    };
  }

  if (content.type === "data" && content.kind === "contacts") {
    const contacts = lunaContactsFromContentData(content.data);
    if (contacts.length === 0) return null;
    return {
      id,
      kind: "contacts",
      contacts,
      text: lunaContactsText(contacts),
      ...contextFields,
    };
  }

  if (content.type !== "file" || !SUPPORTED_FILE_KINDS.has(content.kind)) {
    return null;
  }

  const partKind = lunaBatchPartFileKind(content.kind, content.file.mime_type);
  if (!partKind) return null;

  const base64Data = await fileToBase64(client, content.file.uri);
  if (!base64Data) return null;

  return {
    id,
    kind: partKind,
    mimeType: content.file.mime_type,
    base64Data,
    fileName: content.file.name,
    text: content.text?.trim() || undefined,
    ...contextFields,
  };
}

export async function buildLunaWhatsAppBatchPayload(
  client: SupabaseClient<Database>,
  input: {
    batch: LunaWhatsAppBatchRow;
    organization: OrganizationRow;
  },
): Promise<LunaWhatsAppBatchPayload> {
  const contextHours = lunaWhatsAppBatchContextHours(input.organization);
  const contextMaxMessages = lunaWhatsAppBatchContextMaxMessages(
    input.organization,
  );
  const policy: LunaRecentMessagesPolicy = {
    hours: contextHours,
    maxMessages: contextMaxMessages,
    includeMedia: "batch_only",
  };

  const batchMessageIds = input.batch.message_ids;
  const since = new Date(Date.now() - contextHours * 60 * 60 * 1000)
    .toISOString();

  const threadFilter = {
    organization_id: input.batch.organization_id,
    contact_address: input.batch.contact_address,
    service: input.batch.service,
  };

  // Union: messages in the last N hours OR among the last K for this thread.
  // Hours covers dense recent chat; maxMessages covers delayed replies.
  const [
    { data: batchMessages },
    { data: recentByHours },
    { data: recentByCount },
  ] = await Promise.all([
    client
      .from("messages")
      .select()
      .in("id", batchMessageIds)
      .order("timestamp", { ascending: true })
      .throwOnError(),
    client
      .from("messages")
      .select()
      .eq("organization_id", threadFilter.organization_id)
      .eq("contact_address", threadFilter.contact_address)
      .eq("service", threadFilter.service)
      .gt("timestamp", since)
      .order("timestamp", { ascending: true })
      .throwOnError(),
    client
      .from("messages")
      .select()
      .eq("organization_id", threadFilter.organization_id)
      .eq("contact_address", threadFilter.contact_address)
      .eq("service", threadFilter.service)
      .order("timestamp", { ascending: false })
      .limit(contextMaxMessages)
      .throwOnError(),
  ]);

  const recentById = new Map<string, MessageRow>();
  for (const row of [...(recentByHours ?? []), ...(recentByCount ?? [])]) {
    recentById.set(row.id, row);
  }

  // Any message we send Luna (batch or recent history) that has replyToId
  // should also include that quoted message in recentMessages. Prefer rows
  // already selected; fetch only missing ids (batched).
  const recentRows = [...recentById.values()];
  const recentExternalIds = new Set(
    recentRows.map((m) => m.external_id).filter((id): id is string =>
      Boolean(id)
    ),
  );
  const repliedToIds = collectReplyToIds([
    ...(batchMessages ?? []),
    ...recentRows,
  ]);
  const lookupAttempted = new Set<string>();

  for (let pass = 0; pass < 3; pass++) {
    const missingReplyToIds = [...repliedToIds].filter((id) =>
      !recentExternalIds.has(id) && !lookupAttempted.has(id)
    );
    if (missingReplyToIds.length === 0) break;
    for (const id of missingReplyToIds) lookupAttempted.add(id);

    const { data: replyTargets } = await client
      .from("messages")
      .select()
      .eq("organization_id", threadFilter.organization_id)
      .eq("contact_address", threadFilter.contact_address)
      .eq("service", threadFilter.service)
      .in("external_id", missingReplyToIds)
      .throwOnError();

    const fetched = replyTargets ?? [];
    if (fetched.length === 0) break;

    for (const row of fetched) {
      recentRows.push(row);
      if (row.external_id) recentExternalIds.add(row.external_id);
    }
    for (const id of collectReplyToIds(fetched)) repliedToIds.add(id);
  }

  recentRows.sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );

  // Include media bytes for quoted messages (in-window or fetched), so Luna can
  // resolve image/audio/doc quotes even when policy is batch_only.
  const includeMediaInRecent = policy.includeMedia === "all_in_window";
  const recent = (await Promise.all(
    recentRows.map((message) =>
      messageToLunaRecent(client, message, {
        includeMedia: includeMediaInRecent ||
          Boolean(message.external_id && repliedToIds.has(message.external_id)),
      })
    ),
  )).filter((row): row is LunaRecentMessage => row !== null);

  const batchParts: LunaBatchPart[] = [];
  for (const message of batchMessages ?? []) {
    const part = await messageToBatchPart(client, message);
    if (!part) continue;
    if (Array.isArray(part)) batchParts.push(...part);
    else batchParts.push(part);
  }

  const sortedIds = [...batchMessageIds].sort();
  const idempotencyKey = `${input.batch.organization_id}:${
    normalizeSenderPhone(input.batch.contact_address)
  }:${sortedIds.join(",")}`;

  return {
    idempotencyKey,
    senderPhone: normalizeSenderPhone(input.batch.contact_address),
    receivedAt: new Date().toISOString(),
    contextHours,
    contextMaxMessages,
    recentMessagesPolicy: policy,
    recentMessages: recent,
    batchParts,
  };
}

export async function sendLunaWhatsAppBatch(
  payload: LunaWhatsAppBatchPayload,
): Promise<{ status: number; body: unknown }> {
  const url = Deno.env.get("LUNA_WHATSAPP_BATCH_URL");
  const secret = Deno.env.get("LUNA_WEBHOOK_SECRET");
  if (!url || !secret) {
    throw new Error(
      "LUNA_WHATSAPP_BATCH_URL and LUNA_WEBHOOK_SECRET must be set",
    );
  }

  const response = await ky.post(url, {
    json: payload,
    headers: { Authorization: `Bearer ${secret}` },
    timeout: 120_000,
    throwHttpErrors: false,
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }

  return { status: response.status, body };
}

export async function claimBatchForFlush(
  client: SupabaseClient<Database>,
  batchId: string,
): Promise<LunaWhatsAppBatchRow | null> {
  const { data: openBatch } = await client
    .from("luna_whatsapp_batches")
    .select()
    .eq("id", batchId)
    .eq("status", "open")
    .lte("flush_at", new Date().toISOString())
    .maybeSingle();

  if (!openBatch) return null;

  // One flush per contact at a time — late siblings should wait and absorb/skip.
  const { data: otherFlushing } = await client
    .from("luna_whatsapp_batches")
    .select("id")
    .eq("organization_id", openBatch.organization_id)
    .eq("contact_address", openBatch.contact_address)
    .eq("service", openBatch.service)
    .eq("status", "flushing")
    .neq("id", batchId)
    .limit(1)
    .maybeSingle();

  if (otherFlushing) return null;

  const { data } = await client
    .from("luna_whatsapp_batches")
    .update({ status: "flushing" })
    .eq("id", batchId)
    .eq("status", "open")
    .lte("flush_at", new Date().toISOString())
    .select()
    .maybeSingle();

  return data;
}

function uniqueMessageIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

export type SiblingAbsorbCandidate = {
  id: string;
  created_at: string | null;
};

/**
 * Pure merge of claimed ids with same-Meta-second siblings.
 * Returns `"empty"` when nothing left to send (all already delivered).
 */
export function resolveAbsorbMessageIds(input: {
  claimedMessageIds: string[];
  /** WhatsApp `timestamp` by message id (for claimed rows). */
  batchTimestampsById: Map<string, string>;
  candidates: SiblingAbsorbCandidate[];
  alreadySentIds: Set<string>;
  busyIds: Set<string>;
  openBatchMessageIds: Set<string>;
  nowMs?: number;
  windowMs?: number;
  createdWithinMs?: number;
}): string[] | "empty" {
  const nowMs = input.nowMs ?? Date.now();
  const windowMs = input.windowMs ?? SIBLING_TIMESTAMP_WINDOW_MS;
  const createdWithinMs = input.createdWithinMs ?? SIBLING_CREATED_WITHIN_MS;

  const messageIds = uniqueMessageIds(
    input.claimedMessageIds.filter((id) => !input.alreadySentIds.has(id)),
  );
  if (messageIds.length === 0) return "empty";

  const times = messageIds
    .map((id) => input.batchTimestampsById.get(id))
    .filter((ts): ts is string => Boolean(ts))
    .map((ts) => new Date(ts).getTime());
  if (times.length === 0) return "empty";

  const minTs = Math.min(...times) - windowMs;
  const maxTs = Math.max(...times) + windowMs;
  const createdAfter = new Date(nowMs - createdWithinMs).toISOString();

  for (const row of input.candidates) {
    if (input.busyIds.has(row.id) && !messageIds.includes(row.id)) continue;
    if (input.alreadySentIds.has(row.id)) continue;
    const ts = input.batchTimestampsById.get(row.id);
    // Candidates are pre-filtered by SQL window; when a timestamp is known on
    // the claimed map only, still require freshness for non-claimed ids.
    const isFresh = input.openBatchMessageIds.has(row.id) ||
      (row.created_at != null && row.created_at >= createdAfter);
    if (!isFresh && !messageIds.includes(row.id)) continue;
    // If we somehow got a candidate outside the window (tests), skip it.
    if (ts) {
      const t = new Date(ts).getTime();
      if (t < minTs || t > maxTs) continue;
    }
    messageIds.push(row.id);
  }

  return uniqueMessageIds(messageIds);
}

export type SiblingOpenBatchUpdate =
  | { type: "cancel"; id: string }
  | { type: "trim"; id: string; message_ids: string[] };

/** Decide how to clear absorbed ids from other open batches. */
export function planSiblingOpenBatchUpdates(
  otherOpen: Array<{ id: string; message_ids: string[] }>,
  mergedIds: Set<string>,
): SiblingOpenBatchUpdate[] {
  const updates: SiblingOpenBatchUpdate[] = [];
  for (const other of otherOpen) {
    const remaining = other.message_ids.filter((id) => !mergedIds.has(id));
    if (remaining.length === other.message_ids.length) continue;
    if (remaining.length === 0) {
      updates.push({ type: "cancel", id: other.id });
    } else {
      updates.push({
        type: "trim",
        id: other.id,
        message_ids: remaining,
      });
    }
  }
  return updates;
}

/**
 * After claim: fold in other inbound messages for this contact whose WhatsApp
 * `timestamp` is within ±1s of the batch. Cancels or trims other open batches
 * that only held those siblings so Luna gets one POST.
 *
 * DB shape: 2 parallel reads → 1 sibling read → optional parallel writes.
 */
export async function absorbTimestampSiblingMessages(
  client: SupabaseClient<Database>,
  claimed: LunaWhatsAppBatchRow,
): Promise<LunaWhatsAppBatchRow | "empty"> {
  const thread = {
    organization_id: claimed.organization_id,
    contact_address: claimed.contact_address,
    service: claimed.service,
  };
  const lookbackIso = new Date(Date.now() - RECENTLY_SENT_LOOKBACK_MS)
    .toISOString();

  const [{ data: batchMessages }, { data: contactBatches }] = await Promise.all(
    [
      client
        .from("messages")
        .select(
          "id, timestamp, created_at, direction, service, contact_address, content",
        )
        .in("id", claimed.message_ids)
        .throwOnError(),
      client
        .from("luna_whatsapp_batches")
        .select("id, status, message_ids")
        .eq("organization_id", thread.organization_id)
        .eq("contact_address", thread.contact_address)
        .eq("service", thread.service)
        .in("status", ["open", "flushing", "sent"])
        .neq("id", claimed.id)
        // Always keep open rows; only recent flushing/sent for dedupe.
        .or(`status.eq.open,updated_at.gte."${lookbackIso}"`)
        .throwOnError(),
    ],
  );

  if (!batchMessages?.length) return "empty";

  const alreadySentIds = new Set<string>();
  const busyIds = new Set<string>();
  const openBatchMessageIds = new Set<string>();
  const otherOpen: Array<{ id: string; message_ids: string[] }> = [];

  for (const row of contactBatches ?? []) {
    const ids = row.message_ids ?? [];
    if (row.status === "open") {
      otherOpen.push({ id: row.id, message_ids: ids });
      for (const id of ids) openBatchMessageIds.add(id);
      continue;
    }
    for (const id of ids) {
      busyIds.add(id);
      if (row.status === "sent") alreadySentIds.add(id);
    }
  }

  const remainingClaimed = claimed.message_ids.filter((id) =>
    !alreadySentIds.has(id)
  );
  if (remainingClaimed.length === 0) return "empty";

  const batchTimestampsById = new Map(
    batchMessages.map((m) => [m.id, m.timestamp]),
  );
  const times = remainingClaimed
    .map((id) => batchTimestampsById.get(id))
    .filter((ts): ts is string => Boolean(ts))
    .map((ts) => new Date(ts).getTime());
  if (times.length === 0) return "empty";

  const minTs = new Date(Math.min(...times) - SIBLING_TIMESTAMP_WINDOW_MS)
    .toISOString();
  const maxTs = new Date(Math.max(...times) + SIBLING_TIMESTAMP_WINDOW_MS)
    .toISOString();

  const { data: candidates } = await client
    .from("messages")
    .select(
      "id, timestamp, created_at, direction, service, contact_address, content",
    )
    .eq("organization_id", thread.organization_id)
    .eq("contact_address", thread.contact_address)
    .eq("service", thread.service)
    .eq("direction", "incoming")
    .gte("timestamp", minTs)
    .lte("timestamp", maxTs)
    .throwOnError();

  const eligibleCandidates: SiblingAbsorbCandidate[] = [];
  for (const row of candidates ?? []) {
    if (!shouldEnqueueLunaWhatsAppBatch(row as MessageRow)) continue;
    eligibleCandidates.push({
      id: row.id,
      created_at: row.created_at ?? null,
    });
    if (row.timestamp) batchTimestampsById.set(row.id, row.timestamp);
  }

  const messageIds = resolveAbsorbMessageIds({
    claimedMessageIds: claimed.message_ids,
    batchTimestampsById,
    candidates: eligibleCandidates,
    alreadySentIds,
    busyIds,
    openBatchMessageIds,
  });
  if (messageIds === "empty") return "empty";

  const mergedSet = new Set(messageIds);
  const idsChanged = messageIds.length !== claimed.message_ids.length ||
    messageIds.some((id, i) => id !== claimed.message_ids[i]);
  const openUpdates = planSiblingOpenBatchUpdates(otherOpen, mergedSet);

  const writes: Promise<unknown>[] = [];
  if (idsChanged) {
    writes.push(
      Promise.resolve(
        client
          .from("luna_whatsapp_batches")
          .update({ message_ids: messageIds })
          .eq("id", claimed.id)
          .throwOnError(),
      ),
    );
  }

  for (const update of openUpdates) {
    if (update.type === "cancel") {
      writes.push(
        Promise.resolve(
          client
            .from("luna_whatsapp_batches")
            .update({
              status: "sent",
              luna_response: {
                skipped: true,
                reason: "absorbed_into_sibling_batch",
                absorbed_by: claimed.id,
              },
              error_message: null,
            })
            .eq("id", update.id)
            .eq("status", "open")
            .throwOnError(),
        ),
      );
    } else {
      writes.push(
        Promise.resolve(
          client
            .from("luna_whatsapp_batches")
            .update({ message_ids: update.message_ids })
            .eq("id", update.id)
            .eq("status", "open")
            .throwOnError(),
        ),
      );
    }
  }

  if (writes.length) await Promise.all(writes);

  if (idsChanged) {
    log.info("Absorbed timestamp-sibling messages into Luna batch", {
      batchId: claimed.id,
      messageIds,
    });
  }

  return { ...claimed, message_ids: messageIds };
}

export async function flushLunaWhatsAppBatch(
  client: SupabaseClient<Database>,
  batchId: string,
): Promise<"flushed" | "not_ready" | "skipped"> {
  const claimed = await claimBatchForFlush(client, batchId);
  if (!claimed) return "not_ready";

  if (claimed.attempt_count >= MAX_FLUSH_ATTEMPTS) {
    await client
      .from("luna_whatsapp_batches")
      .update({
        status: "failed",
        error_message: "Max flush attempts exceeded",
      })
      .eq("id", batchId)
      .throwOnError();
    return "skipped";
  }

  const absorbed = await absorbTimestampSiblingMessages(client, claimed);
  if (absorbed === "empty") {
    await client
      .from("luna_whatsapp_batches")
      .update({
        status: "sent",
        luna_response: {
          skipped: true,
          reason: "messages_already_sent_in_sibling_batch",
        },
        error_message: null,
      })
      .eq("id", batchId)
      .throwOnError();
    return "flushed";
  }

  const { data: organization } = await client
    .from("organizations")
    .select()
    .eq("id", absorbed.organization_id)
    .single()
    .throwOnError();

  try {
    const payload = await buildLunaWhatsAppBatchPayload(client, {
      batch: absorbed,
      organization,
    });

    if (
      !payload.batchParts.length && !payload.recentMessages.some((m) => m.text)
    ) {
      await client
        .from("luna_whatsapp_batches")
        .update({
          status: "sent",
          idempotency_key: payload.idempotencyKey,
          luna_response: { skipped: true, reason: "empty_batch" },
          error_message: null,
        })
        .eq("id", batchId)
        .throwOnError();
      return "flushed";
    }

    const result = await sendLunaWhatsAppBatch(payload);

    if (result.status >= 200 && result.status < 300) {
      await client
        .from("luna_whatsapp_batches")
        .update({
          status: "sent",
          idempotency_key: payload.idempotencyKey,
          luna_response: result
            .body as Database["public"]["Tables"]["luna_whatsapp_batches"][
              "Row"
            ]["luna_response"],
          error_message: null,
        })
        .eq("id", batchId)
        .throwOnError();
      log.info("Luna WhatsApp batch flush succeeded", {
        batchId,
        idempotencyKey: payload.idempotencyKey,
        status: result.status,
      });
      return "flushed";
    }

    const errorMessage = typeof result.body === "object" && result.body &&
        "error" in result.body
      ? String((result.body as { error: unknown }).error)
      : `Luna returned HTTP ${result.status}`;

    await client
      .from("luna_whatsapp_batches")
      .update({
        status: result.status === 404 ? "failed" : "open",
        attempt_count: claimed.attempt_count + 1,
        idempotency_key: payload.idempotencyKey,
        luna_response: result
          .body as Database["public"]["Tables"]["luna_whatsapp_batches"]["Row"][
            "luna_response"
          ],
        error_message: errorMessage,
        flush_at: new Date(Date.now() + 30_000).toISOString(),
      })
      .eq("id", batchId)
      .throwOnError();

    log.warn("Luna WhatsApp batch flush failed", {
      batchId,
      status: result.status,
      error: errorMessage,
    });
    return "skipped";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client
      .from("luna_whatsapp_batches")
      .update({
        status: "open",
        attempt_count: claimed.attempt_count + 1,
        error_message: message,
        flush_at: new Date(Date.now() + 30_000).toISOString(),
      })
      .eq("id", batchId)
      .throwOnError();
    log.error("Luna WhatsApp batch flush error", { batchId, error: message });
    return "skipped";
  }
}

export async function flushLunaWhatsAppBatchWhenReady(
  client: SupabaseClient<Database>,
  batchId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data: batch } = await client
      .from("luna_whatsapp_batches")
      .select("id, status, flush_at")
      .eq("id", batchId)
      .maybeSingle();

    if (!batch || batch.status !== "open") return;

    const waitMs = new Date(batch.flush_at).getTime() - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    const result = await flushLunaWhatsAppBatch(client, batchId);
    if (result === "flushed" || result === "skipped") return;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  log.warn("Luna WhatsApp batch debounce watcher gave up", { batchId });
}

export async function flushDueLunaWhatsAppBatches(
  client: SupabaseClient<Database>,
  limit = 20,
): Promise<number> {
  await client
    .from("luna_whatsapp_batches")
    .update({ status: "open" })
    .eq("status", "flushing")
    .lt("updated_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .throwOnError();

  const { data: due } = await client
    .from("luna_whatsapp_batches")
    .select("id")
    .eq("status", "open")
    .lte("flush_at", new Date().toISOString())
    .order("flush_at", { ascending: true })
    .limit(limit);

  let flushed = 0;
  for (const row of due ?? []) {
    const result = await flushLunaWhatsAppBatch(client, row.id);
    if (result === "flushed") flushed += 1;
  }
  return flushed;
}

export type OpenBspOutboundWebhookPayload<T> = {
  data: T;
  entity: string;
  action: string;
};

export function isLunaWhatsAppBatchWebhookPayload(
  body: unknown,
): body is OpenBspOutboundWebhookPayload<MessageRow> {
  if (!body || typeof body !== "object") return false;
  const payload = body as OpenBspOutboundWebhookPayload<MessageRow>;
  return payload.entity === "messages" &&
    payload.action === "insert" &&
    Boolean(payload.data);
}

export function runAfterResponse(promise: Promise<unknown>): void {
  const runtime = globalThis as {
    EdgeRuntime?: { waitUntil(p: Promise<unknown>): void };
  };
  if (runtime.EdgeRuntime) {
    runtime.EdgeRuntime.waitUntil(promise);
    return;
  }
  promise.catch((error) => {
    log.error("Luna WhatsApp batch background task failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function shouldEnqueueLunaWhatsAppBatch(message: MessageRow): boolean {
  if (message.direction !== "incoming") return false;
  if (message.service !== "whatsapp") return false;
  if (!message.contact_address) return false;
  const content = message.content as IncomingMessage;
  if (content.type === "data" && content.kind === "flow-reply") return false;
  return true;
}

export function authorizeLunaWhatsAppBatchWebhookRequest(
  req: Request,
): boolean {
  const expected = Deno.env.get("LUNA_WEBHOOK_TOKEN");
  if (!expected) {
    log.warn("LUNA_WEBHOOK_TOKEN is not set");
    return false;
  }
  const auth = req.headers.get("Authorization");
  const token = auth?.replace(/^Bearer\s+/i, "");
  return token === expected;
}

export function authorizeLunaWhatsAppBatchFlushRequest(req: Request): boolean {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const webhookToken = Deno.env.get("LUNA_WEBHOOK_TOKEN");
  const auth = req.headers.get("Authorization");
  const token = auth?.replace(/^Bearer\s+/i, "");
  return Boolean(
    (serviceKey && token === serviceKey) ||
      (webhookToken && token === webhookToken),
  );
}
