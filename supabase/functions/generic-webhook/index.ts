// Generic inbound webhook for connector-based services (self-hosted bridges
// such as the whatsmeow one). Where the Meta webhooks parse an external API's
// envelope, a connector adapts to OpenBSP and POSTs rows in our native shape;
// this function only resolves the organization, stamps service columns, and
// runs the same persistence the Meta webhooks do (upserts on external_id,
// edits/revokes as in-place updates).
//
// Each connector service is registered in config.toml as its own slug (e.g.
// whatsapp-web-webhook) pointing at THIS entrypoint; the service is derived
// from the slug. Adding a connector = a config.toml block + an env case in
// connectorToken().
//
// Contract (bearer-authenticated with the shared connector token):
//
//   POST /<slug>          JSON event batch (shape below)
//   POST /<slug>/media    multipart form: file=<blob> [, name=<filename>],
//                         plus organization_address; responds
//                         { uri: "internal://media/..." } for use in a
//                         subsequent FilePart.
//
// Event batch:
//
//   {
//     organization_address: string,     // the connector session's own address
//     messages?:  [{ external_id, conversation_address, sender_address?,
//                    sender_name?, conversation_name?, thread_id?, content,
//                    status?, timestamp, muted?, archived? }],
//     statuses?:  [{ external_id, conversation_address,
//                    status }],         // delivery receipts
//     contacts?:  [{ address, extra? }],// names, avatars
//     groups?:    [{ address, name? }], // group subject → conversation name
//     edits?:     [{ original_message_id, conversation_address?,
//                    sender_address?, text, timestamp }],
//     revokes?:   [{ original_message_id, timestamp }],
//   }
//
// Names and chat state are DENORMALIZED per message (the connector's address
// book is the directory OpenBSP cannot see): sender_name folds into the
// sender's contacts_addresses.extra, conversation_name onto the conversation
// row, muted/archived into conversations.extra — each reaching rows from that
// message on, never retroactively. The connector omits muted/archived when
// false, so on live messages absence means unmuted/unarchived.
//
// Automation gating rides on the existing status.pending convention: a LIVE
// message omits `status`, so the column default ({pending: now()}) arms the
// agent/media-preprocessor triggers; HISTORY imports and echoes carry an
// explicit final status (e.g. {"read": ...}) and are therefore inert. Do not
// add a separate history flag.
//
// Reactions: content passes through verbatim, so connectors should emit the
// cross-service ReactionPart shape (type 'data', kind 'reaction', text =
// Unicode emoji or "" on removal, data {action, name, unicode} — see
// _shared/types/message_types.ts). Legacy TextPart kind 'reaction' payloads
// from older bridge builds are still stored as-is; readers accept both.
import * as log from "../_shared/logger.ts";
import {
  type ContactAddressInsert,
  createUnsecureClient,
  type IncomingMessage,
  type IncomingStatus,
  type MessageInsert,
  type OutgoingMessage,
  type OutgoingStatus,
} from "../_shared/supabase.ts";
import { MAX_STORAGE_UPLOAD_SIZE, uploadToStorage } from "../_shared/media.ts";
import type { Database, Json } from "../_shared/db_types.ts";

type Service = Database["public"]["Enums"]["service"];

/** Derives the service from the function slug (e.g. /whatsapp-web-webhook)
 * or, when invoked under the generic slug, from the subpath
 * (/generic-webhook/whatsapp-web). */
function serviceFromRequest(req: Request): string {
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  const slug = segments[0] ?? "";
  if (slug === "generic-webhook") return segments[1] ?? "";
  return slug.replace(/-webhook$/, "");
}

/** Per-service shared bearer token the connector authenticates with. */
function connectorToken(service: string): string | null {
  if (service === "whatsapp-web") {
    return Deno.env.get("WHATSAPP_WEB_TOKEN") ?? "";
  }
  return null;
}

/** A billing-cap rejection. billing.check_limit raises SQLSTATE PT402 —
 * PostgREST maps that to HTTP 402 by itself, so callers see the code
 * directly; the Storage API instead flattens the trigger raise into its
 * message ("database error, code: PT402"), hence the text checks. */
function isQuotaError(error: unknown): boolean {
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  return code === "PT402" || text.includes("PT402") ||
    /Usage limit reached for|Insufficient balance for/.test(text);
}

// Anything the handler throws — a malformed batch body, a .throwOnError()
// on the contacts/conversations upserts, an edit/revoke update — used to
// bubble to the runtime, which answers 500 with nothing on stdout. Catch it
// here so every 500 says why. Quota rejections are not faults: they answer
// 402 so the connector knows not to retry and can degrade instead (e.g. send
// the message as a media_placeholder, stamping status.errors).
Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const path = new URL(req.url).pathname;

    if (isQuotaError(error)) {
      // The Storage API flattens the raise to "database error, code: P0001";
      // storage is the only product enforced on that path, so name it.
      const body = path.endsWith("/media")
        ? "Usage limit reached for storage"
        : message;
      log.warn("Connector request rejected by billing cap", { message, path });
      return new Response(body, { status: 402 });
    }

    log.error("Connector webhook failed", { error: message, path });
    return new Response("Internal error", { status: 500 });
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const service = serviceFromRequest(req) as Service;
  const expectedToken = connectorToken(service);

  if (expectedToken === null) {
    return new Response(`No connector configured for service '${service}'`, {
      status: 404,
    });
  }

  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (!expectedToken || token !== expectedToken) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();
  const isMedia = new URL(req.url).pathname.endsWith("/media");

  const resolveOrganization = async (
    organization_address: string | null,
  ): Promise<string | null> => {
    if (!organization_address) return null;

    const { data } = await client
      .from("organizations_addresses")
      .select("organization_id")
      .eq("service", service)
      .eq("address", organization_address)
      .maybeSingle()
      .throwOnError();

    return data?.organization_id ?? null;
  };

  if (isMedia) {
    const form = await req.formData();
    const file = form.get("file");
    const name = form.get("name");
    const organization_address = form.get("organization_address");

    if (!(file instanceof Blob) || typeof organization_address !== "string") {
      return new Response("file and organization_address are required", {
        status: 400,
      });
    }

    const organization_id = await resolveOrganization(organization_address);
    if (!organization_id) {
      return new Response("Unknown organization address", { status: 404 });
    }

    if (file.size > MAX_STORAGE_UPLOAD_SIZE) {
      return new Response("File exceeds storage upload limit", {
        status: 413,
      });
    }

    const uri = await uploadToStorage(
      client,
      organization_id,
      file,
      typeof name === "string" ? name : undefined,
    );

    return Response.json({ uri });
  }

  const batch = (await req.json()) as {
    organization_address?: string;
    messages?: Array<{
      external_id: string;
      /** The chat: group JID, or the peer address for direct chats */
      conversation_address: string;
      /** The contact who authored the message (the group participant, or the
       * DM peer); omitted when the account itself spoke (echoes, history). */
      sender_address?: string;
      /** What this account calls the author (address book first, pushname
       * otherwise); absent for the account's own messages. */
      sender_name?: string;
      /** The group's subject, or the peer's name for a direct chat. */
      conversation_name?: string;
      thread_id?: string;
      content: Json;
      status?: Record<string, Json>;
      timestamp: string;
      /** The chat's own mute/archive state when the message arrived; omitted
       * when false, live traffic only. */
      muted?: boolean;
      archived?: boolean;
    }>;
    statuses?: Array<{
      external_id: string;
      // The chat the receipt belongs to. Required by the BEFORE INSERT
      // trigger, which runs ahead of conflict detection and resolves a
      // conversation even though the upsert only ever merges status.
      conversation_address: string;
      status: Record<string, Json>;
    }>;
    contacts?: Array<{
      address: string;
      extra?: Record<string, Json>;
    }>;
    groups?: Array<{
      address: string;
      name?: string;
    }>;
    edits?: Array<{
      original_message_id: string;
      /** The chat and author, so an edit whose original never arrived can
       * still land as a row instead of vanishing. */
      conversation_address?: string;
      sender_address?: string;
      text: string;
      timestamp: string;
    }>;
    revokes?: Array<{ original_message_id: string; timestamp: string }>;
  };

  const organization_id = await resolveOrganization(
    batch.organization_address ?? null,
  );
  if (!organization_id) {
    log.warn("Connector webhook for unknown organization address", {
      service,
      organization_address: batch.organization_address,
    });
    return new Response("Unknown organization address", { status: 404 });
  }

  const organization_address = batch.organization_address!;

  // Sender names ride the messages themselves; fold them into the same
  // upsert as the contacts feed, feed entries last so an explicit contact
  // wins over a per-message name within the batch.
  const contactRows = new Map<string, ContactAddressInsert>();

  for (const message of batch.messages ?? []) {
    if (!message.sender_address || !message.sender_name) continue;

    contactRows.set(message.sender_address, {
      organization_id,
      organization_address,
      service,
      address: message.sender_address,
      extra: { name: message.sender_name },
    });
  }

  for (const contact of batch.contacts ?? []) {
    contactRows.set(contact.address, {
      organization_id,
      organization_address,
      service,
      address: contact.address,
      extra: contact.extra,
    });
  }

  if (contactRows.size > 0) {
    // Conflict target defaults to the PK (organization_id,
    // organization_address, service, address); extra is folded in by the
    // merge_update trigger.
    await client.from("contacts_addresses").upsert([...contactRows.values()])
      .throwOnError();
  }

  // Delivery receipts ride as outgoing rows with empty content, exactly like
  // the Meta webhooks: the row exists (the dispatcher inserted it), so the
  // upsert only merges status. See whatsapp-webhook for the rationale on
  // upserting statuses and messages in two separate statements.
  // One batch can carry several receipts for the same message — a bridge that
  // saw `sent` and `read` in the same poll sends both. Postgres refuses to let
  // one ON CONFLICT statement touch a row twice (SQLSTATE 21000), so they
  // cannot both be rows here.
  //
  // Collapsing to the last one would throw away the other receipt, which is
  // the opposite of what the status column is for. Instead fold them into a
  // single patch — {sent} + {read} becomes {sent, read} — which is precisely
  // what the merge trigger would have produced had they arrived in two
  // statements. Later keys win on collision, matching last-write-wins per key.
  const statusPatches = new Map<string, OutgoingStatus>();

  for (const status of batch.statuses ?? []) {
    const merged = {
      ...statusPatches.get(status.external_id),
      ...(status.status as OutgoingStatus),
    };

    statusPatches.set(status.external_id, merged);
  }

  const statusAddresses = new Map(
    (batch.statuses ?? []).map((s) => [s.external_id, s.conversation_address]),
  );

  const statuses: MessageInsert[] = [...statusPatches].map((
    [external_id, status],
  ) => ({
    organization_id,
    service,
    organization_address,
    external_id,
    conversation_address: statusAddresses.get(external_id),
    content: {} as OutgoingMessage, // this will get merged (it won't overwrite)
    status,
  }));

  const messages: MessageInsert[] = (batch.messages ?? []).map(
    (message) => {
      const base = {
        organization_id,
        service,
        organization_address,
        external_id: message.external_id,
        conversation_address: message.conversation_address,
        thread_id: message.thread_id,
        timestamp: message.timestamp,
      };

      // Status is omitted for live messages so the column default
      // ({pending: now()}) arms automation; explicit for history/echoes so
      // they stay inert.
      return message.sender_address
        ? {
          ...base,
          sender_address: message.sender_address,
          content: message.content as unknown as IncomingMessage,
          ...(message.status && {
            status: message.status as IncomingStatus,
          }),
        }
        : {
          ...base,
          content: message.content as unknown as OutgoingMessage,
          ...(message.status && {
            status: message.status as OutgoingStatus,
          }),
        };
    },
  );

  // Conversations are normally minted by before_insert_on_messages, which
  // defaults `type` to direct — right for every 1:1 chat and wrong for anything
  // else. Only the connector can tell the difference, and it tells it by the
  // address: the whatsmeow bridge sends a bare phone number for direct chats
  // and a full JID otherwise, whose domain names the kind (the same test its
  // dispatcher applies in reverse). So pre-create those rows before the
  // messages land.
  //
  // ignoreDuplicates: an existing conversation is left exactly as it is — this
  // classifies new ones, it does not retype old ones.
  const containerType = (address: string): "group" | "broadcast" | undefined =>
    address.endsWith("@g.us")
      ? "group"
      : address.endsWith("@broadcast")
      ? "broadcast"
      : undefined;

  const containers = new Map<string, "group" | "broadcast">();

  for (const { conversation_address } of messages) {
    if (!conversation_address) continue;

    const type = containerType(conversation_address);

    if (type) containers.set(conversation_address, type);
  }

  if (containers.size > 0) {
    await client
      .from("conversations")
      .upsert(
        [...containers].map(([address, type]) => ({
          organization_id,
          service,
          organization_address,
          address,
          type,
        })),
        {
          onConflict: "organization_id,service,organization_address,address",
          ignoreDuplicates: true,
        },
      )
      .throwOnError();
  }

  const upsertBatch = async (label: string, rows: MessageInsert[]) => {
    if (rows.length === 0) return;

    const { error } = await client
      .from("messages")
      .upsert(rows, { onConflict: "external_id" });

    if (error) {
      log.error(`Failed to upsert ${label}`, {
        error,
        service,
        organization_address,
        count: rows.length,
      });
      throw error;
    }
  };

  await upsertBatch("statuses", statuses);
  // Live (status-less) rows go in their own statement: PostgREST normalizes
  // a batch to the union of its columns, so mixing them with stamped rows
  // would send status: null — violating NOT NULL instead of applying the
  // column default ({pending: now()}).
  await upsertBatch("live messages", messages.filter((m) => !m.status));
  await upsertBatch("stamped messages", messages.filter((m) => m.status));

  // Per-message conversation facts, applied after the upserts so rows the
  // batch itself minted exist: the denormalized name, and the chat's own
  // mute/archive state into extra (merge_update folds it in). State comes
  // from LIVE messages only — history and echoes don't carry it — and
  // absence on a live message means false (the connector omits false), so
  // an unmute reaches from the next message on. Last message per chat wins.
  type ConversationFacts = {
    name?: string;
    muted?: boolean;
    archived?: boolean;
  };
  const conversationFacts = new Map<string, ConversationFacts>();

  for (const message of batch.messages ?? []) {
    const facts = conversationFacts.get(message.conversation_address) ?? {};

    if (message.conversation_name) facts.name = message.conversation_name;

    if (!message.status) {
      facts.muted = message.muted ?? false;
      facts.archived = message.archived ?? false;
    }

    conversationFacts.set(message.conversation_address, facts);
  }

  for (const [address, facts] of conversationFacts) {
    const patch: Record<string, Json> = {};

    if (facts.name) patch.name = facts.name;
    if (facts.muted !== undefined) {
      patch.extra = { muted: facts.muted, archived: facts.archived ?? false };
    }

    if (Object.keys(patch).length === 0) continue;

    await client
      .from("conversations")
      .update(patch)
      .eq("organization_id", organization_id)
      .eq("service", service)
      .eq("address", address)
      .throwOnError();
  }

  // Group subjects land on the conversation name. Runs after the per-message
  // names so the feed — the authoritative subject — wins within a batch; a
  // standalone rename for an unknown group matches no rows, which is fine.
  for (const group of batch.groups ?? []) {
    if (!group.name) continue;

    await client
      .from("conversations")
      .update({ name: group.name })
      .eq("organization_id", organization_id)
      .eq("service", service)
      .eq("address", group.address)
      .throwOnError();
  }

  // Edits and revokes are in-place updates keyed by the ORIGINAL external
  // id, after the upserts so an original delivered in the same batch exists.
  // The merge_update triggers on content/status fold the patch in — a caption
  // edit on media replaces content.text and leaves the file alone.
  for (const edit of batch.edits ?? []) {
    const { original_message_id, conversation_address, sender_address, text } =
      edit;

    const { data: updated } = await client
      .from("messages")
      .update({ content: { text }, status: { edited: edit.timestamp } })
      .eq("external_id", original_message_id)
      .select("id")
      .throwOnError();

    // No original — it predates the session or fell in a gap. When the edit
    // carries its coordinates, land it as the message row instead of dropping
    // the words; stamped status keeps it inert to automation.
    if (updated.length === 0 && conversation_address) {
      await client
        .from("messages")
        .upsert([{
          organization_id,
          service,
          organization_address,
          external_id: original_message_id,
          conversation_address,
          ...(sender_address && { sender_address }),
          content: {
            version: "1",
            type: "text",
            kind: "text",
            text,
          } as unknown as IncomingMessage,
          status: { edited: edit.timestamp } as IncomingStatus,
          timestamp: edit.timestamp,
        }], { onConflict: "external_id" })
        .throwOnError();
    }
  }

  for (const { original_message_id, timestamp } of batch.revokes ?? []) {
    await client
      .from("messages")
      .update({ status: { deleted: timestamp } })
      .eq("external_id", original_message_id)
      .throwOnError();
  }

  return new Response();
}
