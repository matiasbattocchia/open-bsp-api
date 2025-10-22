import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import {
  type IncomingMessageV1,
  type OutgoingMessageV1,
  type MessageInsertV1,
  type ConversationInsert,
  type MessageInsert,
  type OutgoingMessage,
  type MetaWebhookPayload,
  type WebhookIncomingMessage,
  type WebhookEchoMessage,
  type WebhookHistoryMessage,
  type MessageRow,
  createUnsecureClient,
} from "../_shared/supabase.ts";
import { fetchMedia, uploadToStorage } from "../_shared/media.ts";
import { fromV1 } from "../_shared/messages-v0.ts";

const API_VERSION = "v24.0";
const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN");
const APP_ID = Deno.env.get("META_APP_ID");
const APP_SECRET = Deno.env.get("META_APP_SECRET");
const DEFAULT_ACCESS_TOKEN =
  Deno.env.get("META_SYSTEM_USER_ACCESS_TOKEN") || "";

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
    log.warn("WHATSAPP_VERIFY_TOKEN environment variable not set");
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
 * Validates the WhatsApp webhook signature to ensure the request comes from Meta
 * @param request The incoming request
 * @returns Promise<boolean> true if signature is valid, false otherwise
 */
async function validateWebhookSignature(request: Request): Promise<boolean> {
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

  if (appId === "no-verify") {
    return true;
  }

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
    // Clone the request to read the body without consuming it
    const clonedRequest = request.clone();
    const body = await clonedRequest.text();

    // Create HMAC-SHA256 signature
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

    const signature = await crypto.subtle.sign("HMAC", cryptoKey, data);
    const expectedSignature = Array.from(new Uint8Array(signature))
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

async function downloadMediaItem({
  organization_id,
  access_token,
  message,
  client,
}: {
  organization_id: string;
  access_token: string;
  message: MessageInsertV1;
  client: SupabaseClient;
}): Promise<MessageInsertV1> {
  if (message.message.type !== "file") {
    return message;
  }

  const media_id = message.message.file.uri;
  const filename = message.message.file.name;

  // Fetch part 1: Get the download url using the media id
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${media_id}`,
    {
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  const mediaMetadata = (await response.json()) as {
    messaging_product: "whatsapp";
    url: string;
    mime_type: string;
    sha256: string;
    file_size: number;
    id: string;
  };

  // Fetch part 2: Get the file using the download url
  const file = await fetchMedia(mediaMetadata.url, access_token);

  // Store the file
  const uri = await uploadToStorage(client, organization_id, file, filename);

  message.message.file.uri = uri; // Overwrite WA media id with the internal uri
  message.message.file.size = mediaMetadata.file_size;

  return message;
}

/** Patches messages with media local id and file size
 *
 * @param mediaMessages
 * @returns modified messages
 */
async function downloadMedia(
  mediaMessages: MessageInsertV1[],
  client: SupabaseClient,
): Promise<MessageInsertV1[]> {
  if (!mediaMessages.length) {
    return [];
  }

  const unique_number_ids = [
    ...new Set(mediaMessages.map((m) => m.organization_address)),
  ]; // organization_address is the WA phone_number_id

  const { data: addresses, error: queryError } = await client
    .from("organizations_addresses")
    .select("organization_id, address, extra->>access_token")
    .in("address", unique_number_ids);

  if (queryError) {
    throw queryError;
  }

  addresses.forEach((a) => {
    a.access_token ||= DEFAULT_ACCESS_TOKEN;
  });

  const number_ids_to_org_ids: Map<string, string> = new Map(
    addresses.map((a) => [a.address, a.organization_id]),
  );

  const number_ids_to_access_tokens: Map<string, string> = new Map(
    addresses.map((a) => [a.address, a.access_token]),
  );

  return Promise.all(
    mediaMessages.map((message) =>
      downloadMediaItem({
        organization_id: number_ids_to_org_ids.get(
          message.organization_address,
        )!,
        access_token: number_ids_to_access_tokens.get(
          message.organization_address,
        )!,
        message,
        client,
      }),
    ),
  );
}

function webhookMessageToIncomingMessageV1(
  message: WebhookIncomingMessage | WebhookEchoMessage | WebhookHistoryMessage,
): IncomingMessageV1 | undefined {
  let re_message_id: string | undefined;
  let forwarded: boolean | undefined;

  // Handle context information for incoming messages
  if ("context" in message && message.context) {
    if (message.context.id) {
      re_message_id = message.context.id;
    }
    if (message.context.forwarded) {
      forwarded = true;
    }
  }

  // Handle reactions - they reference a message differently
  if (message.type === "reaction") {
    re_message_id = message.reaction.message_id;
  }

  const baseMessage = {
    version: "1" as const,
    ...(re_message_id && { re_message_id }),
    ...(forwarded && { forwarded }),
  };

  switch (message.type) {
    case "text": {
      return {
        ...baseMessage,
        type: "text",
        kind: "text",
        text: message.text.body,
      };
    }

    case "reaction": {
      return {
        ...baseMessage,
        type: "text",
        kind: "reaction",
        text: message.reaction.emoji || "",
      };
    }

    case "audio": {
      return {
        ...baseMessage,
        type: "file",
        kind: "audio",
        file: {
          mime_type: message.audio.mime_type,
          uri: message.audio.id, // Will be replaced with internal URI after download
          size: 0, // Will be updated after download
        },
      };
    }

    case "image": {
      return {
        ...baseMessage,
        type: "file",
        kind: "image",
        file: {
          mime_type: message.image.mime_type,
          uri: message.image.id, // Will be replaced with internal URI after download
          size: 0, // Will be updated after download
        },
        ...(message.image.caption && { text: message.image.caption }),
      };
    }

    case "video": {
      return {
        ...baseMessage,
        type: "file",
        kind: "video",
        file: {
          mime_type: message.video.mime_type,
          uri: message.video.id, // Will be replaced with internal URI after download
          name: message.video.filename,
          size: 0, // Will be updated after download
        },
        ...(message.video.caption && { text: message.video.caption }),
      };
    }

    case "document": {
      return {
        ...baseMessage,
        type: "file",
        kind: "document",
        file: {
          mime_type: message.document.mime_type,
          uri: message.document.id, // Will be replaced with internal URI after download
          name: message.document.filename,
          size: 0, // Will be updated after download
        },
        ...(message.document.caption && { text: message.document.caption }),
      };
    }

    case "sticker": {
      return {
        ...baseMessage,
        type: "file",
        kind: "sticker",
        file: {
          mime_type: message.sticker.mime_type,
          uri: message.sticker.id, // Will be replaced with internal URI after download
          size: 0, // Will be updated after download
        },
      };
    }

    case "contacts": {
      return {
        ...baseMessage,
        type: "data",
        kind: "contacts",
        data: message.contacts,
      };
    }

    case "location": {
      return {
        ...baseMessage,
        type: "data",
        kind: "location",
        data: message.location,
      };
    }

    case "order": {
      return {
        ...baseMessage,
        type: "data",
        kind: "order",
        data: message.order,
      };
    }

    case "interactive": {
      return {
        ...baseMessage,
        type: "data",
        kind: "interactive",
        data: message.interactive,
      };
    }

    case "button": {
      return {
        ...baseMessage,
        type: "data",
        kind: "button",
        data: message.button,
      };
    }

    case "media_placeholder": {
      return {
        ...baseMessage,
        type: "data",
        kind: "media_placeholder",
        data: null,
      };
    }

    case "system":
    /*
    // TODO: it seems that this message can be mark as read
    // TODO: customer_identity_changed
    if (message.system.type === "customer_changed_number") {
      const old_wa_id = message.system!.customer;
      const new_wa_id = message.system!.wa_id;

      // TODO: outdated
      const { error } = await client
        .from("contacts")
        .update({ extra: { whatsapp_id: new_wa_id } })
        .eq("organization_address", organization_address)
        .eq("extra->>whatsapp_id", old_wa_id);

      if (error) {
        log.error(
          `Could not update contact with old whatsapp id ${old_wa_id} during contact number update`,
          error,
        );
        continue;
      }
    }
    */
    case "unsupported":
    default: {
      // System and unsupported messages are not converted to IncomingMessageV1
      // They should be handled separately or filtered out before calling this function
      log.error(
        `Message type "${message.type}" cannot be converted to IncomingMessageV1`,
        message,
      );
    }
  }
}

async function processMessage(request: Request): Promise<Response> {
  // Validate that the request comes from Meta
  const isValidSignature = await validateWebhookSignature(request);

  if (!isValidSignature) {
    return new Response("Unauthorized: Invalid webhook signature", {
      status: 401,
    });
  }

  const client = createUnsecureClient();

  const payload = (await request.json()) as MetaWebhookPayload;

  if (payload.object !== "whatsapp_business_account") {
    return new Response("Unexpected object", { status: 400 });
  }

  const messages: MessageInsertV1[] = [];
  const conversations: Set<ConversationInsert> = new Set();
  const statuses: MessageInsert[] = [];

  for (const entry of payload.entry) {
    const _waba_id = entry.id; // WhatsApp business account ID (WABA ID)

    for (const { value, field } of entry.changes) {
      log.info(`WhatsApp ${field} payload`, value);
      const organization_address = value.metadata.phone_number_id; // WhatsApp business account phone number id

      if (field === "messages" && "contacts" in value) {
        for (const contact of value.contacts) {
          conversations.add({
            service: "whatsapp",
            organization_address,
            contact_address: contact.wa_id,
            name: contact.profile.name,
          });
        }
      }

      if (field === "messages" && "messages" in value) {
        for (const webhookMessage of value.messages) {
          const contact_address = webhookMessage.from;
          const content = webhookMessageToIncomingMessageV1(webhookMessage);

          if (!content) {
            continue;
          }

          const message = {
            // id is the internal (aka surrogate) identifier given by the DB, while
            // external_id is the one given by the service, such as the WhatsApp message id (WAMID)
            external_id: webhookMessage.id,
            service: "whatsapp" as const,
            organization_address,
            contact_address,
            type: "incoming" as const, // TODO: deprecate with v0
            direction: "incoming" as const,
            message: content,
            timestamp: new Date(webhookMessage.timestamp * 1000).toISOString(),
          };

          messages.push(message);
        }
      }

      if (field === "messages" && "statuses" in value) {
        for (const status of value.statuses) {
          statuses.push({
            external_id: status.id,
            service: "whatsapp",
            organization_address,
            contact_address: status.recipient_id,
            type: "outgoing",
            direction: "outgoing",
            message: {} as OutgoingMessage, // this will get merged (it won't overwrite)
            status: {
              [status.status]: new Date(
                parseInt(status.timestamp) * 1000,
              ).toISOString(),
              errors: status.errors,
            },
          });
        }
      }

      if (field === "messages" && "errors" in value) {
        for (const error of value.errors) {
          log.error(
            `WhatsApp error for organization address (phone number id) ${organization_address}`,
            error,
          );

          client
            .from("organizations_addresses")
            .update({
              extra: {
                logs: [
                  {
                    webhook: "messages",
                    timestamp: new Date().toISOString(),
                    level: "error",
                    message: error,
                  },
                ],
              },
            })
            .eq("address", organization_address);
        }
      }

      if (field === "smb_message_echoes") {
        for (const webhookMessage of value.message_echoes) {
          const contact_address = webhookMessage.to;

          conversations.add({
            service: "whatsapp",
            organization_address,
            contact_address,
          });

          const content = webhookMessageToIncomingMessageV1(webhookMessage);

          if (!content) {
            continue;
          }

          const message = {
            // id is the internal (aka surrogate) identifier given by the DB, while
            // external_id is the one given by the service, such as the WhatsApp message id (WAMID)
            external_id: webhookMessage.id,
            service: "whatsapp" as const,
            organization_address,
            contact_address,
            type: "outgoing" as const, // TODO: deprecate with v0
            direction: "outgoing" as const,
            message: content as OutgoingMessageV1, // Incoming are a superset of outgoing, except for templates
            status: {
              sent: new Date(webhookMessage.timestamp * 1000).toISOString(),
            },
            timestamp: new Date(webhookMessage.timestamp * 1000).toISOString(),
          };

          messages.push(message);
        }
      }

      if (field === "history") {
        for (const history of value.history) {
          if ("threads" in history) {
            // fire and forget
            client
              .from("organizations_addresses")
              .update({
                extra: {
                  logs: [
                    {
                      webhook: "history",
                      timestamp: new Date().toISOString(),
                      level: "info",
                      message: history.metadata,
                    },
                  ],
                },
              })
              .eq("address", organization_address);

            for (const thread of history.threads) {
              conversations.add({
                service: "whatsapp",
                organization_address,
                contact_address: thread.id,
              });

              for (const webhookMessage of thread.messages) {
                const isEcho = "to" in webhookMessage;

                const contact_address = isEcho
                  ? webhookMessage.to!
                  : webhookMessage.from;

                const content =
                  webhookMessageToIncomingMessageV1(webhookMessage);

                if (!content) {
                  continue;
                }

                const historyStatusMap = {
                  READ: "read",
                  DELIVERED: "delivered",
                  SENT: "sent",
                  ERROR: "failed",
                  PLAYED: "read",
                  PENDING: "pending",
                };

                const message = isEcho
                  ? {
                      // id is the internal (aka surrogate) identifier given by the DB, while
                      // external_id is the one given by the service, such as the WhatsApp message id (WAMID)
                      external_id: webhookMessage.id,
                      service: "whatsapp" as const,
                      organization_address,
                      contact_address,
                      type: "outgoing" as const, // TODO: deprecate with v0
                      direction: "outgoing" as const,
                      message: content as OutgoingMessageV1, // Incoming are a superset of outgoing, except for templates
                      status: {
                        [historyStatusMap[
                          webhookMessage.history_context.status
                        ]]: new Date(
                          webhookMessage.timestamp * 1000,
                        ).toISOString(),
                      },
                      timestamp: new Date(
                        webhookMessage.timestamp * 1000,
                      ).toISOString(),
                    }
                  : {
                      // id is the internal (aka surrogate) identifier given by the DB, while
                      // external_id is the one given by the service, such as the WhatsApp message id (WAMID)
                      external_id: webhookMessage.id,
                      service: "whatsapp" as const,
                      organization_address,
                      contact_address,
                      type: "incoming" as const, // TODO: deprecate with v0
                      direction: "incoming" as const,
                      message: content, // Incoming are a superset of outgoing, except for templates
                      status: {
                        [historyStatusMap[
                          webhookMessage.history_context.status
                        ]]: new Date(
                          webhookMessage.timestamp * 1000,
                        ).toISOString(),
                      },
                      timestamp: new Date(
                        webhookMessage.timestamp * 1000,
                      ).toISOString(),
                    };

                messages.push(message);
              }
            }
          }

          if ("errors" in history) {
            for (const error of history.errors) {
              client
                .from("organizations_addresses")
                .update({
                  extra: {
                    logs: [
                      {
                        webhook: "history",
                        timestamp: new Date().toISOString(),
                        level: "error",
                        message: error,
                      },
                    ],
                  },
                })
                .eq("address", organization_address);
            }
          }
        }
      }

      if (field === "smb_app_state_sync") {
        for (const syncItem of value.state_sync) {
          if (syncItem.type === "contact" && syncItem.action === "add") {
            conversations.add({
              service: "whatsapp",
              organization_address,
              contact_address: syncItem.contact.phone_number,
              name: syncItem.contact.full_name,
              extra: {
                smb_contact: true,
              },
            });
          }
        }
      }
    }
  }

  const downloadMediaPromise = downloadMedia(messages, client);

  // Notes:
  // 1. Upsert is needed because there is no bulk update
  // 2. Insert operation is not expected, statuses come
  //    after outgoing messages are inserted
  // 3. Only the status field should be updated based on external_id,
  //    but upsert requires records to be prepared for insertion (which won't happen)
  // 4. message field is present at {}, it will be merged during update (inocuous)
  const { error: statusesError } = await client
    .from("messages")
    .upsert(statuses, {
      onConflict: "external_id",
    });

  if (statusesError) {
    throw statusesError;
  }

  // Conversations table has a before insert trigger which acts as an upsert.
  // It won't create a new conversation if an active one exists.
  // It updates the name if provided.
  const { error: conversationsError } = await client
    .from("conversations")
    .insert(Array.from(conversations));

  if (conversationsError) {
    throw conversationsError;
  }

  // Download media before upserting incoming messages
  // Patched messages include media local id and file size
  const patchedMessages = await downloadMediaPromise;

  const messagesV0 = patchedMessages
    .map(fromV1)
    .filter(Boolean) as MessageRow[];

  const { error: messagesError } = await client
    .from("messages")
    .upsert(messagesV0, {
      onConflict: "external_id",
    });

  if (messagesError) {
    throw messagesError;
  }

  return new Response();
}
