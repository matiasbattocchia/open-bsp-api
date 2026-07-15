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
//     messages?:  [{ external_id, direction, contact_address?, group_address?,
//                    thread_id?, content, status?, timestamp }],
//     statuses?:  [{ external_id, contact_address?, group_address?, status }],
//                                       // delivery receipts
//     contacts?:  [{ address, extra? }],// names, avatars
//     edits?:     [{ original_message_id, text, timestamp }],
//     revokes?:   [{ original_message_id, timestamp }],
//   }
//
// Automation gating rides on the existing status.pending convention: a LIVE
// message omits `status`, so the column default ({pending: now()}) arms the
// agent/media-preprocessor triggers; HISTORY imports and echoes carry an
// explicit final status (e.g. {"read": ...}) and are therefore inert. Do not
// add a separate history flag.
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

Deno.serve(async (req) => {
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
      direction: "incoming" | "outgoing";
      contact_address?: string;
      group_address?: string;
      thread_id?: string;
      content: Json;
      status?: Record<string, Json>;
      timestamp: string;
    }>;
    statuses?: Array<{
      external_id: string;
      // The chat the receipt belongs to. Required by the BEFORE INSERT
      // trigger, which runs ahead of conflict detection and resolves a
      // conversation even though the upsert only ever merges status.
      contact_address?: string;
      group_address?: string;
      status: Record<string, Json>;
    }>;
    contacts?: Array<{
      address: string;
      extra?: Record<string, Json>;
    }>;
    edits?: Array<{
      original_message_id: string;
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

  if (batch.contacts?.length) {
    const rows: ContactAddressInsert[] = batch.contacts.map((contact) => ({
      organization_id,
      service,
      address: contact.address,
      extra: contact.extra,
    }));

    // Conflict target defaults to the PK (organization_id, service,
    // address); extra is folded in by the merge_update trigger.
    await client.from("contacts_addresses").upsert(rows).throwOnError();
  }

  // Delivery receipts ride as outgoing rows with empty content, exactly like
  // the Meta webhooks: the row exists (the dispatcher inserted it), so the
  // upsert only merges status. See whatsapp-webhook for the rationale on
  // upserting statuses and messages in two separate statements.
  const statuses: MessageInsert[] = (batch.statuses ?? []).map((status) => ({
    organization_id,
    service,
    organization_address,
    direction: "outgoing" as const,
    external_id: status.external_id,
    contact_address: status.contact_address,
    group_address: status.group_address,
    content: {} as OutgoingMessage, // this will get merged (it won't overwrite)
    status: status.status as OutgoingStatus,
  }));

  const messages: MessageInsert[] = (batch.messages ?? []).map(
    (message) => {
      const base = {
        organization_id,
        service,
        organization_address,
        external_id: message.external_id,
        contact_address: message.contact_address,
        group_address: message.group_address,
        thread_id: message.thread_id,
        timestamp: message.timestamp,
      };

      // Status is omitted for live messages so the column default
      // ({pending: now()}) arms automation; explicit for history/echoes so
      // they stay inert.
      return message.direction === "incoming"
        ? {
          ...base,
          direction: "incoming" as const,
          content: message.content as unknown as IncomingMessage,
          ...(message.status && {
            status: message.status as IncomingStatus,
          }),
        }
        : {
          ...base,
          direction: "outgoing" as const,
          content: message.content as unknown as OutgoingMessage,
          ...(message.status && {
            status: message.status as OutgoingStatus,
          }),
        };
    },
  );

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

  // Edits and revokes are in-place updates keyed by the ORIGINAL external
  // id, after the upserts so an original delivered in the same batch exists.
  for (const { original_message_id, text, timestamp } of batch.edits ?? []) {
    await client
      .from("messages")
      .update({ content: { text }, status: { edited: timestamp } })
      .eq("external_id", original_message_id)
      .throwOnError();
  }

  for (const { original_message_id, timestamp } of batch.revokes ?? []) {
    await client
      .from("messages")
      .update({ status: { deleted: timestamp } })
      .eq("external_id", original_message_id)
      .throwOnError();
  }

  return new Response();
});
