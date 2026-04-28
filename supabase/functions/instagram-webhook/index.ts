import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import {
  type ContactAddressExtra,
  type ContactAddressInsert,
  createUnsecureClient,
  type Database,
  type IncomingMessage,
  type InstagramAttachment,
  type InstagramEvent,
  type InstagramMessage,
  type InstagramReferral,
  type InstagramWebhookPayload,
  type MessageInsert,
  type OrganizationAddressRow,
  type OutgoingMessage,
} from "../_shared/supabase.ts";
import {
  fetchMedia,
  MAX_STORAGE_UPLOAD_SIZE,
  uploadToStorage,
} from "../_shared/media.ts";

const API_VERSION = "v25.0";
const VERIFY_TOKEN = Deno.env.get("INSTAGRAM_VERIFY_TOKEN");
const APP_ID = Deno.env.get("META_APP_ID");
const APP_SECRET = Deno.env.get("META_APP_SECRET");

// 30 days. Username is refreshed when older than this; tunable via constant.
const NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Queries the database for organization addresses and returns a map.
 * Fetches first active address per address value (ordered by created_at desc).
 */
async function buildOrgAddressMap(
  client: SupabaseClient<Database>,
  addresses: string[],
): Promise<Map<string, OrganizationAddressRow>> {
  if (addresses.length === 0) return new Map();

  const { data } = await client
    .from("organizations_addresses")
    .select()
    .in("address", addresses)
    .eq("status", "connected")
    .eq("service", "instagram")
    .order("created_at", { ascending: false })
    .throwOnError();

  const map = new Map<string, typeof data[number]>();

  for (const row of data) {
    if (!map.has(row.address)) {
      map.set(row.address, row);
    }
  }

  return map;
}

/**
 * Flattens an entry's events. Instagram delivers events through both
 * `entry.messaging[]` (legacy Messenger shape) and `entry.changes[].value`
 * (newer fanout shape). We flatten both into one stream.
 */
function extractEvents(entry: InstagramWebhookPayload["entry"][number]): InstagramEvent[] {
  const events: InstagramEvent[] = [];

  if (entry.messaging) {
    events.push(...entry.messaging);
  }

  if (entry.changes) {
    const eventFields = new Set([
      "messages",
      "messaging_postbacks",
      "messaging_seen",
      "message_reactions",
      "message_edit",
      "messaging_referral",
    ]);

    for (const change of entry.changes) {
      if (eventFields.has(change.field) && change.value) {
        events.push(change.value);
      }
    }
  }

  return events;
}

/**
 * Collects every IGSID we'll need to look up org addresses for. Both
 * `recipient.id` and `sender.id` are pushed because echoes flip them.
 */
function collectOrgAddresses(payload: InstagramWebhookPayload): string[] {
  const ids = new Set<string>();

  for (const entry of payload.entry) {
    for (const event of extractEvents(entry)) {
      ids.add(event.recipient.id);
      ids.add(event.sender.id);
    }
  }

  return Array.from(ids);
}

Deno.serve(async (request) => {
  switch (request.method) {
    case "GET":
      return verifyToken(request);
    case "POST":
      return await processMessage(request);
  }

  return new Response("Method not implemented", { status: 501 });
});

function verifyToken(request: Request): Response {
  if (!VERIFY_TOKEN) {
    log.warn("INSTAGRAM_VERIFY_TOKEN environment variable not set");
  }

  const params = new URL(request.url).searchParams;

  if (
    params.get("hub.mode") === "subscribe" &&
    params.get("hub.verify_token") === VERIFY_TOKEN
  ) {
    return new Response(params.get("hub.challenge"));
  }

  return new Response("Verification failed, tokens do not match", {
    status: 403,
  });
}

/**
 * Validates the Instagram webhook signature to ensure the request comes from Meta.
 * Mirrors whatsapp-webhook's validation, including the multi-app
 * META_APP_ID|secret1|secret2 splitting and `app_id` query-param routing —
 * the same Meta app may host both WA and IG products, but multiple apps may
 * also be configured.
 */
async function validateWebhookSignature(request: Request, body: string): Promise<boolean> {
  if (!APP_ID || !APP_SECRET) {
    log.warn("META_APP_ID or META_APP_SECRET environment variable not set");
    return false;
  }

  const ids = APP_ID.split("|");
  const secrets = APP_SECRET.split("|");

  if (ids.length !== secrets.length) {
    log.warn(
      "META_APP_ID and META_APP_SECRET environment variables must have the same number of elements, separated by '|'",
    );
    return false;
  }

  let idIndex = 0;

  const url = new URL(request.url);
  const appId = url.searchParams.get("app_id");

  if (appId) {
    idIndex = ids.indexOf(appId);

    if (idIndex === -1) {
      log.warn(
        `Could not find app_id '${appId}' in META_APP_ID environment variable`,
      );
      return false;
    }
  }

  const signature = request.headers.get("X-Hub-Signature-256");

  if (!signature) {
    log.warn("Missing X-Hub-Signature-256 header");
    return false;
  }

  const signatureValue = signature.replace("sha256=", "");

  try {
    const encoder = new TextEncoder();
    const key = encoder.encode(secrets[idIndex]);
    const data = encoder.encode(body);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const hmac = await crypto.subtle.sign("HMAC", cryptoKey, data);
    const expectedSignature = Array.from(new Uint8Array(hmac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const isValid = signatureValue === expectedSignature;

    if (!isValid) {
      log.warn("Invalid webhook signature", {
        expected: expectedSignature,
        received: signatureValue,
      });
    }

    return isValid;
  } catch (error) {
    log.error(
      "Error validating webhook signature",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Downloads an Instagram media URL and uploads it to internal storage.
 * Instagram attachment URLs are short-lived public CDN URLs — no Bearer
 * token needed (unlike WhatsApp's two-step download flow).
 */
async function downloadMediaItem({
  organization_id,
  message,
  client,
}: {
  organization_id: string;
  message: MessageInsert;
  client: SupabaseClient;
}): Promise<MessageInsert> {
  if (message.content.type !== "file") {
    return message;
  }

  const url = message.content.file.uri;
  const filename = message.content.file.name;

  // Fetch part 1: Instagram delivers a short-lived public CDN URL directly in
  // the webhook attachment payload — no metadata round-trip is needed (unlike
  // WhatsApp, which gives a media id that must first be resolved to a URL).

  log.info("Downloading IG media", { url });

  // Fetch part 2: Get the file using the public URL (no auth)
  const file = await fetchMedia(url);

  const file_size = file.size;
  message.content.file.size = file_size;

  // Check storage upload size limit
  if (file_size > MAX_STORAGE_UPLOAD_SIZE) {
    const sizeMB = (file_size / (1000 * 1000)).toFixed(1);
    const limitMB = (MAX_STORAGE_UPLOAD_SIZE / (1000 * 1000)).toFixed(0);

    log.warn("Media file exceeds storage upload limit", {
      url,
      file_size,
      limit: MAX_STORAGE_UPLOAD_SIZE,
    });

    // Preserve message with original Instagram media reference and error status
    message.status = { error: `File too large: ${sizeMB} MB (limit: ${limitMB} MB)` };
    return message;
  }

  // Store the file
  const uri = await uploadToStorage(client, organization_id, file, filename);

  message.content.file.uri = uri; // Overwrite IG media URL with the internal uri

  return message;
}

/**
 * Fetches the IG username via Graph API (Instagram API with Instagram Login).
 * Returns undefined on failure so the caller can decide what to store.
 */
async function fetchSenderUsername(
  igsid: string,
  accessToken: string,
): Promise<string | undefined> {
  if (!accessToken) {
    log.warn(`No Instagram access token, cannot fetch username for ${igsid}`);
    return undefined;
  }

  try {
    const response = await fetch(
      `https://graph.instagram.com/${API_VERSION}/${igsid}?fields=username,name&access_token=${accessToken}`,
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      log.warn(
        `Failed to fetch IG profile for ${igsid}: ${response.status} — ${errorBody}`,
      );
      return undefined;
    }

    const profile = (await response.json()) as {
      username?: string;
      name?: string;
    };

    return profile.username || profile.name;
  } catch (error) {
    log.warn(`Error fetching IG profile for ${igsid}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Maps an Instagram attachment to an IncomingMessage content. Each
 * attachment becomes its own row; quick_reply, text, and unsupported are
 * handled separately by the caller.
 *
 * Multi-attachment note: Instagram sends a single `mid` per `event.message`,
 * so when an event yields N>1 content rows, the caller suffixes external_id
 * as `${mid}#${index}` to keep the unique constraint happy.
 */
function attachmentToContent(
  attachment: InstagramAttachment,
  base: Pick<IncomingMessage, "version" | "re_message_id" | "re_story" | "referral">,
): IncomingMessage | undefined {
  const url = attachment.payload?.url;

  switch (attachment.type) {
    case "audio":
      if (!url) return undefined;
      return {
        ...base,
        type: "file",
        kind: "audio",
        file: { mime_type: "audio/mpeg", uri: url, size: 0 },
      };

    case "file":
      if (!url) return undefined;
      // IG calls this "file" (e.g. pdf). We keep the native flavor as kind: "file"
      // even though WhatsApp's analogous concept is kind: "document".
      return {
        ...base,
        type: "file",
        kind: "file",
        file: { mime_type: "application/pdf", uri: url, size: 0 },
      };

    case "image":
      if (!url) return undefined;
      return {
        ...base,
        type: "file",
        kind: "image",
        file: { mime_type: "image/jpeg", uri: url, size: 0 },
      };

    case "video":
      if (!url) return undefined;
      return {
        ...base,
        type: "file",
        kind: "video",
        file: { mime_type: "video/mp4", uri: url, size: 0 },
      };

    case "media":
      if (!url) return undefined;
      return {
        ...base,
        type: "file",
        kind: "media",
        file: { mime_type: "application/octet-stream", uri: url, size: 0 },
      };

    case "ig_post":
    case "story_mention":
    case "ig_reel":
    case "reel":
    case "story":
    case "ig_story":
      return {
        ...base,
        type: "data",
        kind: attachment.type,
        data: attachment.payload,
      };
  }
}

/**
 * Builds the content rows for an Instagram message event. Returns an array
 * because messages with multiple attachments yield one row per attachment.
 */
function instagramMessageToContent(msg: InstagramMessage): IncomingMessage[] {
  const base = {
    version: "1" as const,
    ...(msg.reply_to?.mid && { re_message_id: msg.reply_to.mid }),
    ...(msg.reply_to?.story && { re_story: msg.reply_to.story }),
    ...(msg.referral && { referral: msg.referral }),
  };

  if (msg.is_unsupported) {
    return [{
      ...base,
      type: "data",
      kind: "unsupported",
      data: { type: "edit" }, // placeholder to satisfy the unsupported shape
    }];
  }

  // Quick replies always carry text alongside the postback payload.
  if (msg.quick_reply) {
    return [{
      ...base,
      type: "data",
      kind: "button",
      data: { text: msg.text ?? "", payload: msg.quick_reply.payload },
      ...(msg.text && { text: msg.text }),
    }];
  }

  if (msg.attachments && msg.attachments.length > 0) {
    const contents: IncomingMessage[] = [];
    for (const attachment of msg.attachments) {
      const content = attachmentToContent(attachment, base);
      if (content) {
        contents.push(content);
      } else {
        log.warn("Could not convert IG attachment", attachment);
      }
    }
    return contents;
  }

  if (msg.text !== undefined) {
    return [{
      ...base,
      type: "text",
      kind: "text",
      text: msg.text,
    }];
  }

  log.warn("Could not convert Instagram message to content", msg);
  return [];
}

async function processMessage(request: Request): Promise<Response> {
  const body = await request.text();

  // Validate that the request comes from Meta
  const isValidSignature = await validateWebhookSignature(request, body);

  if (!isValidSignature) {
    // Return 200 to prevent Meta from retrying. Common cause: the user deleted
    // their org but didn't remove the webhook from their Meta app configuration.
    return new Response();
  }

  const client = createUnsecureClient();

  const payload = JSON.parse(body) as InstagramWebhookPayload;

  if (payload.object !== "instagram") {
    return new Response("Unexpected object", { status: 400 });
  }

  const orgAddressMap = await buildOrgAddressMap(
    client,
    collectOrgAddresses(payload),
  );

  // Username TTL cache: pre-fetch existing contacts_addresses rows so we only
  // call the Graph API for IGSIDs that are missing or stale (>30 days).
  const contactCache = new Map<string, ContactAddressExtra>();
  const usernamePromises = new Map<string, Promise<string | undefined>>();

  // Collect IGSIDs that may need a username.
  const contactIgsids = new Set<string>();
  for (const entry of payload.entry) {
    for (const event of extractEvents(entry)) {
      const isEcho = !!event.message?.is_echo;
      const contactAddress = isEcho ? event.recipient.id : event.sender.id;
      contactIgsids.add(contactAddress);
    }
  }

  if (contactIgsids.size > 0) {
    const orgIds = Array.from(
      new Set(
        Array.from(orgAddressMap.values()).map((r) => r.organization_id),
      ),
    );

    if (orgIds.length > 0) {
      const { data } = await client
        .from("contacts_addresses")
        .select("address, extra")
        .in("organization_id", orgIds)
        .eq("service", "instagram")
        .in("address", Array.from(contactIgsids))
        .throwOnError();

      for (const row of data) {
        contactCache.set(row.address, (row.extra ?? {}) as ContactAddressExtra);
      }
    }
  }

  function resolveUsername(
    igsid: string,
    orgAddress: OrganizationAddressRow,
  ): { promise: Promise<string | undefined>; needsRefresh: boolean } {
    const existing = contactCache.get(igsid);
    const fetchedAt = existing?.name_fetched_at
      ? Date.parse(existing.name_fetched_at)
      : 0;
    const now = Date.now();
    const stale = !existing?.name || (now - fetchedAt) >= NAME_TTL_MS;

    if (!stale) {
      return { promise: Promise.resolve(existing!.name), needsRefresh: false };
    }

    let promise = usernamePromises.get(igsid);
    if (!promise) {
      const accessToken = orgAddress.extra?.access_token ?? "";
      promise = fetchSenderUsername(igsid, accessToken);
      usernamePromises.set(igsid, promise);
    }

    return { promise, needsRefresh: true };
  }

  const messages: MessageInsert[] = [];
  const statuses: MessageInsert[] = [];
  const contacts_addresses: ContactAddressInsert[] = [];

  // Track which (org_id, address) pairs we've already pushed to contacts_addresses
  // so we don't refresh a username more than once per webhook.
  const contactPushed = new Set<string>();

  async function pushContactWithName(
    organization_id: string,
    igsid: string,
    orgAddress: OrganizationAddressRow,
  ) {
    const dedupKey = `${organization_id}|${igsid}`;
    if (contactPushed.has(dedupKey)) return;
    contactPushed.add(dedupKey);

    const { promise, needsRefresh } = resolveUsername(igsid, orgAddress);
    if (!needsRefresh) return; // cache hit — no upsert needed

    const fetched = await promise;
    const previousName = contactCache.get(igsid)?.name;
    // If the fetch failed but we had a prior name, keep it.
    const name = fetched ?? previousName;

    contacts_addresses.push({
      organization_id,
      address: igsid,
      service: "instagram",
      extra: {
        ...(name !== undefined && { name }),
        name_fetched_at: new Date().toISOString(),
      },
    });
  }

  for (const entry of payload.entry) {
    for (const event of extractEvents(entry)) {
      // Skip dev-mode test messages sent to the org's own account.
      if (event.message?.is_self) {
        log.info("Skipping is_self test message", { mid: event.message.mid });
        continue;
      }

      const isEcho = !!event.message?.is_echo;
      const organization_address = isEcho ? event.sender.id : event.recipient.id;
      const contact_address = isEcho ? event.recipient.id : event.sender.id;

      const orgAddressRow = orgAddressMap.get(organization_address);
      if (!orgAddressRow) {
        log.warn("No organization address for Instagram event", {
          organization_address,
        });
        continue;
      }

      const organization_id = orgAddressRow.organization_id;
      const timestamp = new Date(event.timestamp).toISOString();

      // ---- Top-level referral (messaging_referral) — no message attached.
      if (event.referral && !event.message) {
        await pushContactWithName(organization_id, contact_address, orgAddressRow);

        const refContent: IncomingMessage = {
          version: "1",
          type: "data",
          kind: "referral",
          data: event.referral as InstagramReferral,
        };

        messages.push({
          organization_id,
          external_id: `${entry.id}#referral#${event.timestamp}`,
          service: "instagram",
          organization_address,
          contact_address,
          direction: "incoming",
          content: refContent,
          timestamp,
        });
        continue;
      }

      // ---- Postback (icebreaker / CTA button)
      if (event.postback) {
        await pushContactWithName(organization_id, contact_address, orgAddressRow);

        messages.push({
          organization_id,
          external_id: event.postback.mid,
          service: "instagram",
          organization_address,
          contact_address,
          direction: "incoming",
          content: {
            version: "1",
            type: "data",
            kind: "button",
            data: {
              text: event.postback.title,
              payload: event.postback.payload,
            },
            text: event.postback.title,
          },
          timestamp,
        });
        continue;
      }

      // ---- Reaction (insert new row, mirroring WA reaction model)
      if (event.reaction) {
        messages.push({
          organization_id,
          external_id: `${event.reaction.mid}#reaction#${event.timestamp}`,
          service: "instagram",
          organization_address,
          contact_address,
          direction: "incoming",
          content: {
            version: "1",
            type: "text",
            kind: "reaction",
            text: event.reaction.emoji ?? "",
            re_message_id: event.reaction.mid,
          },
          timestamp,
        });
        continue;
      }

      // ---- Read receipt — merge onto the original outgoing row.
      if (event.read) {
        statuses.push({
          organization_id,
          external_id: event.read.mid,
          service: "instagram",
          organization_address,
          contact_address,
          direction: "outgoing",
          content: {} as OutgoingMessage, // {} is a no-op under merge_update
          status: { read: timestamp },
        });
        continue;
      }

      // ---- Edit — update the original row in place (no new row, no history).
      // The merge trigger replaces `text` (string leaf) and merges status.
      if (event.message_edit) {
        messages.push({
          organization_id,
          external_id: event.message_edit.mid,
          service: "instagram",
          organization_address,
          contact_address,
          direction: "incoming",
          content: {
            version: "1",
            type: "text",
            kind: "text",
            text: event.message_edit.text,
            data: { num_edit: event.message_edit.num_edit },
          } as IncomingMessage,
          status: { edited: timestamp },
          timestamp,
        });
        continue;
      }

      // ---- Message (incoming or echo)
      if (event.message) {
        const msg = event.message;

        // Deletion — update the original row in place via the status merge trigger.
        if (msg.is_deleted) {
          statuses.push(
            isEcho
              ? {
                organization_id,
                external_id: msg.mid,
                service: "instagram",
                organization_address,
                contact_address,
                direction: "outgoing",
                content: {} as OutgoingMessage,
                status: { deleted: timestamp },
              }
              : {
                organization_id,
                external_id: msg.mid,
                service: "instagram",
                organization_address,
                contact_address,
                direction: "incoming",
                content: {} as IncomingMessage,
                status: { deleted: timestamp },
              },
          );
          continue;
        }

        if (!isEcho) {
          await pushContactWithName(
            organization_id,
            contact_address,
            orgAddressRow,
          );
        }

        const contents = instagramMessageToContent(msg);
        if (contents.length === 0) continue;

        const multi = contents.length > 1;
        contents.forEach((content, index) => {
          const external_id = multi ? `${msg.mid}#${index}` : msg.mid;
          if (isEcho) {
            messages.push({
              organization_id,
              external_id,
              service: "instagram",
              organization_address,
              contact_address,
              direction: "outgoing",
              content: content as OutgoingMessage,
              status: { sent: timestamp },
              timestamp,
            });
          } else {
            messages.push({
              organization_id,
              external_id,
              service: "instagram",
              organization_address,
              contact_address,
              direction: "incoming",
              content,
              timestamp,
            });
          }
        });
        continue;
      }

      log.info("Unhandled Instagram event shape", event);
    }
  }

  log.info("Webhook processing summary", {
    messages: messages.length,
    statuses: statuses.length,
    contacts_addresses: contacts_addresses.length,
    organizations: Array.from(orgAddressMap.entries()).map(([address, row]) => ({
      organization_id: row.organization_id,
      organization_address: address,
    })),
  });

  // Download media (one-step: IG attachment URLs are public CDN URLs, no auth).
  const downloadMediaPromise = Promise.all(
    messages.map(async (message) => {
      const orgAddress = orgAddressMap.get(message.organization_address)!;

      try {
        return await downloadMediaItem({
          organization_id: orgAddress.organization_id,
          message,
          client,
        });
      } catch (error) {
        log.warn(
          "Failed to download IG media, preserving message with original reference",
          {
            error: error instanceof Error ? error.message : String(error),
            message_id: message.external_id,
          },
        );

        message.status = {
          error: error instanceof Error ? error.message : String(error),
        };
        return message;
      }
    }),
  );

  if (contacts_addresses.length > 0) {
    // Deduplicate by (organization_id, address, service): a single batch may
    // produce multiple events for the same contact. Keep the last entry —
    // most recent fetched_at wins.
    const dedupedContactsAddresses = Array.from(
      new Map(
        contacts_addresses.map((ca) => [
          `${ca.organization_id}|${ca.address}|${ca.service}`,
          ca,
        ]),
      ).values(),
    );

    const { error: contactsError } = await client
      .from("contacts_addresses")
      .upsert(dedupedContactsAddresses);

    if (contactsError) {
      log.error("Failed to upsert contacts_addresses", {
        error: contactsError,
        contacts_addresses: dedupedContactsAddresses,
      });
      throw contactsError;
    }
  }

  // See WA webhook for the rationale on the upsert pattern: status rows ride
  // alongside messages, with empty content so the merge trigger only updates
  // the status field.
  const patchedMessages = await downloadMediaPromise;

  const allMessages = [...statuses, ...patchedMessages];

  if (allMessages.length > 0) {
    const { error: messagesError } = await client
      .from("messages")
      .upsert(allMessages, {
        onConflict: "external_id",
      });

    if (messagesError) {
      log.error("Failed to upsert messages", {
        error: messagesError,
        message_count: allMessages.length,
      });
      throw messagesError;
    }

    log.info("Persisted messages", {
      total: allMessages.length,
      statuses: statuses.length,
      messages: patchedMessages.length,
    });
  }

  return new Response();
}
