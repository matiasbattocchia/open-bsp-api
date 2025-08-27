import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import {
  type IncomingMessage,
  type MessageInsert,
  type ConversationInsert,
  type MessageUpdate,
  type OutgoingStatus,
  type WebhookMessage,
  type WebhookStatus,
  type BaseMessage,
  createUnsecureClient,
} from "../_shared/supabase.ts";
import { fetchMedia, uploadToStorage } from "../_shared/media.ts";

const API_VERSION = "v23.0";
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

async function downloadMediaItem({
  organization_id,
  media_id,
  access_token,
  messageRecord,
  client,
  filename,
}: {
  organization_id: string;
  media_id: string;
  access_token: string;
  messageRecord: MessageInsert;
  client: SupabaseClient;
  filename?: string;
}): Promise<MessageInsert> {
  if (!(messageRecord.message as BaseMessage).media) {
    throw new Error(
      `Message with id ${messageRecord.id} is missing the media property.`,
    );
  }

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

  (messageRecord.message as BaseMessage).media!.id = uri; // Overwrite WA media id with the internal uri
  (messageRecord.message as BaseMessage).media!.file_size =
    mediaMetadata.file_size;

  return messageRecord;
}

/** Patches messages with media local id and file size
 *
 * @param mediaMessages
 * @returns modified messages
 */
async function downloadMedia(
  mediaMessages: MessageInsert[],
  client: SupabaseClient,
): Promise<MessageInsert[]> {
  if (!mediaMessages.length) return [];

  const unique_number_ids = [
    ...new Set(mediaMessages.map((m) => m.organization_address)),
  ]; // organization_address is the WA phone_number_id

  const { data: addresses, error: queryError } = await client
    .from("organizations_addresses")
    .select("organization_id, address, extra->>access_token")
    .in("address", unique_number_ids);

  if (queryError) throw queryError;

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
    mediaMessages.map((m) =>
      downloadMediaItem({
        organization_id: number_ids_to_org_ids.get(m.organization_address)!,
        media_id: (m.message as BaseMessage).media!.id,
        access_token: number_ids_to_access_tokens.get(m.organization_address)!,
        messageRecord: m,
        client,
        filename: (m.message as BaseMessage).media!.filename,
      }),
    ),
  );
}

/**
 * About the payload error fields madness. We can encounter error messages at
 *   1. value.errors - not totally understand this
 *   2. value.messages[].errors - incoming messages errors such as user sending unsupported message
 *   3. value.statuses[].errors - outgoing messages errors
 */
async function processMessage(request: Request): Promise<Response> {
  // Validate that the request comes from Meta
  const isValidSignature = await validateWebhookSignature(request);

  if (!isValidSignature) {
    return new Response("Unauthorized: Invalid webhook signature", {
      status: 401,
    });
  }

  const client = createUnsecureClient();

  const payload = await request.json();

  if (payload.object !== "whatsapp_business_account") {
    return new Response("Unexpected object", { status: 400 });
  }

  const messages: MessageInsert[] = [];
  const mediaMessages: MessageInsert[] = [];
  const contacts: Map<string, string> = new Map(); // key: WA ID, value: name
  const conversations: Set<ConversationInsert> = new Set();
  const statuses: MessageUpdate[] = [];

  for (const entry of payload.entry) {
    const _waba_id = entry.id; // WhatsApp business account ID (WABA ID)

    for (const { value, field } of entry.changes) {
      log.info("WhatsApp payload", value);
      const organization_address = value.metadata.phone_number_id; // WhatsApp business account phone number id

      let valueMessages = [];

      if (field === "messages") {
        valueMessages = value.messages;
      } else if (field === "smb_message_echoes") {
        valueMessages = value.message_echoes;
      } else if (field === "history") {
        // Extract messages from history threads
        valueMessages = value.history.threads
          .map((thread: any) => thread.messages)
          .flat();
      }

      if (valueMessages) {
        for (const message of valueMessages as WebhookMessage[]) {
          let contact_address = message.from; // Phone number

          if (
            field === "smb_message_echoes" ||
            (field === "history" && message.to)
          ) {
            contact_address = message.to;
          }

          switch (message.type) {
            case "system": {
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
              break;
            }
            case "unknown":
            case "unsupported": {
              if (message.errors) {
                for (const error of message.errors) {
                  log.warn(
                    `Incoming message error from contact address ${contact_address} to organization address ${organization_address}`,
                    error.message,
                  );
                }
              }
              break;
            }
            default: {
              const { id, from, to, timestamp, ...andMore } = message;

              // Message echo is a outgoing message with incoming message payload
              const inMessage = andMore as IncomingMessage;

              if (message.context?.id) {
                // "re" stands for refered: a message that is replied, reacted or forwarded.
                // It references the message WAMID, which is stored in `external_id`.
                // It is not the same as our internal message `id`!
                // TODO: I wonder if we should use the `id` field instead (in a reliable way). - cabra 2025/01/29
                inMessage.re_message_id = message.context.id;
              }

              if (message.context?.forwarded) {
                inMessage.forwarded = true;
                delete inMessage.context?.forwarded;
              }

              /* Note: We are in the process of moving away from the WhatsApp message types to the more generic BaseMessage type.
               * Thus, we are deleting the WhatsApp-specific properties from the inMessage object.
               * Nonetheless, we are storing every other property not present in the BaseMessage type, till the moment we handle them properly.
               */
              switch (message.type) {
                case "text":
                  inMessage.content = message.text.body;
                  if ("text" in inMessage) {
                    delete inMessage.text;
                  }
                  break;
                case "reaction":
                  inMessage.content = message.reaction.emoji || "";
                  inMessage.re_message_id = message.reaction.message_id;
                  if ("reaction" in inMessage) {
                    delete inMessage.reaction;
                  }
                  break;
                case "button":
                  // TODO: handle payload
                  inMessage.content = message.button.text;
                  break;
                case "audio":
                  inMessage.media = message.audio;
                  if ("audio" in inMessage) {
                    delete inMessage.audio;
                  }
                  break;
                case "document":
                  if (message.document.caption) {
                    inMessage.content = message.document.caption;
                  }
                  inMessage.media = message.document;
                  if ("document" in inMessage) {
                    delete inMessage.document;
                  }
                  break;
                case "image":
                  if (message.image.caption) {
                    inMessage.content = message.image.caption;
                  }
                  inMessage.media = message.image;
                  if ("image" in inMessage) {
                    delete inMessage.image;
                  }
                  break;
                case "sticker":
                  inMessage.media = message.sticker;
                  if ("sticker" in inMessage) {
                    delete inMessage.sticker;
                  }
                  break;
                case "video":
                  if (message.video.caption) {
                    inMessage.content = message.video.caption;
                  }
                  inMessage.media = message.video;
                  if ("video" in inMessage) {
                    delete inMessage.video;
                  }
                  break;
                case "contacts": {
                  // TODO: workaround till handled properly in the UI and the bot
                  const contactsInfo = message.contacts.map((contact) => {
                    const name = contact.name.formatted_name;
                    const phones =
                      contact.phones?.map((p) => p.phone).join(", ") || "";
                    return name + (phones ? "\n" + phones : "");
                  });

                  inMessage.content = contactsInfo.join("\n\n");
                  break;
                }
                case "interactive":
                  // TODO: handle payload
                  inMessage.content =
                    "button_reply" in message.interactive
                      ? message.interactive.button_reply.title
                      : message.interactive.list_reply.title;
                  break;
              }

              // Determine message status based on field type
              let messageStatus = {};
              if (field === "smb_message_echoes") {
                messageStatus = {
                  sent: new Date(timestamp * 1000).toISOString(),
                };
              } else if (
                field === "history" &&
                message.history_context?.status
              ) {
                messageStatus = {
                  [message.history_context.status.toLowerCase()]: undefined,
                };
              }

              const inMessageRecord: MessageInsert = {
                // id is the internal (aka surrogate) identifier given by the DB, while
                // external_id is the one given by the service, such as the WhatsApp message id (WAMID)
                external_id: id,
                service: "whatsapp",
                organization_address,
                contact_address,
                type:
                  field === "smb_message_echoes" ||
                  (field === "history" && message.to)
                    ? "outgoing"
                    : "incoming",
                direction:
                  field === "smb_message_echoes" ||
                  (field === "history" && message.to)
                    ? "outgoing"
                    : "incoming",
                message: inMessage,
                ...(messageStatus && Object.keys(messageStatus).length > 0
                  ? { status: messageStatus }
                  : {}),
                timestamp: new Date(timestamp * 1000).toISOString(),
              };

              if (inMessage.media) {
                mediaMessages.push(inMessageRecord);
              } else {
                messages.push(inMessageRecord);
              }

              conversations.add({
                service: "whatsapp",
                organization_address,
                contact_address,
              });
            }
          }
        }
      }

      if (value.contacts) {
        for (const contact of value.contacts) {
          contacts.set(contact.wa_id, contact.profile.name);
        }
      }

      if (value.errors) {
        for (const error of value.errors) {
          log.warn(
            `WhatsApp error for organization address (phone number id) ${organization_address}`,
            error.message,
          );
        }
      }

      /**
       * About the conversations-based pricing madness.
       * https://developers.facebook.com/docs/whatsapp/pricing
       *
       * **
       * WhatsApp dubs conversations as sessions.
       * For us conversations mean chats/threads.
       * For WhatsApp, conversations are 24-hour sessions.
       * **
       *
       * ## Customer Service Windows
       *
       * When a customer messages you, a 24-hour timer called a customer service window starts.
       * If you are within the window, you can send free-form messages or template messages.
       * If you are outside the window, you can only send template messages.
       *
       * ## Conversation Categories
       *
       * Marketing, utility, and authentication conversations can only be opened with template messages.
       * Service conversations can only be opened with free-form messages.
       *
       * ## Marketing, Utility, and Authentication Conversations
       *
       * When you send an approved marketing, utility, or authentication template
       * to a customer, we check if an open conversation matching the template's category already exists between you and the customer.
       * If one exists, no new conversation is opened. If one does not exist, a new conversation of that category is opened, lasting 24 hours.
       *
       * ## Service Conversations
       *
       * When you send a free-form message to a customer (which can only be done if a customer service window exists between you and the customer),
       * we check if an open conversation — of any category — already exists between you and the customer.
       * If one exists, no new conversation is opened. If a conversation does not exist, a new service conversation is opened, lasting 24 hours.
       *
       * ## Conversation Duration
       *
       * Marketing, utility, authentication, and service conversations last 24 hours unless closed by a newly opened free-entry point conversation.
       * Free-entry point conversations last 72 hours.
       *
       * ## Free Entry Point Conversations
       *
       * A free entry point conversation is opened if (1) a customer using a device running Android or iOS
       * messages you via a Click to WhatsApp Ad or Facebook Page Call-to-Action button and (2) you respond within 24 hours.
       * If you do not respond within 24 hours, a free entry point conversation is not opened and you must use a template
       * to message the customer, which opens a marketing, utility, or authentication conversation, per the category of the template.
       *
       * The free entry point conversation is opened as soon as your message is delivered and lasts 72 hours.
       * When a free entry point conversation is opened, it automatically closes all other open conversations between you and the customer,
       * and no new conversations will be opened until the free entry point conversation expires.
       *
       * Once the free entry point conversation is opened, you can send any type of message to the customer without incurring additional charges.
       * However, you can only send free-form messages if there is an open customer service window between you and the customer.
       *
       * ## Free Tier Conversations
       *
       * Each WhatsApp Business Account gets 1000 free service conversations each month across all of its business phone numbers.
       * This number is refreshed at the beginning of each month, based on WhatsApp Business Account time zone.
       * Marketing, utility and authentication conversations are not part of the free tier.
       *
       * ---
       *
       * ## Notes
       *
       * 1. To track Customer Service Windows in Conversations would be costly, since we should update the expiration datetime each time there is
       *    an incoming message. Let's just check the last message timestamp at the bot function and the UI.
       *
       * 2. Total conversations per billing period = Number of unique conversation IDs associated
       *    with a WABA ID with status "delivered" or "read" in that billing period.
       *
       *    PRE
       *
       *    Does the status has an indicator of a new conversation? I think it doesn't.
       *    Work around: check status.conversation.expiration_timestamp - now >= 86000
       *    Then update the conversation (ours) with the session category and id.
       *    Only notifications with status.status = 'sent' have the expiration_timestamp field.
       *
       *    POST
       *
       *    select count(distinct status->conversation->>id)
       *    from messages as m
       *    join organization_addresses as a
       *    on m.organization_address = a.address
       *    where m.status->>status = 'delivered' or m.status->>status = 'read'
       *      and m.service = 'whatsapp'
       *    group by a.extra->>waba_id, month(m.timestamp, a.extra->>timezone)
       */

      if (value.statuses) {
        for (const status of value.statuses as WebhookStatus[]) {
          const outStatus: OutgoingStatus = {
            [status.status]: new Date(
              parseInt(status.timestamp) * 1000,
            ).toISOString(),
          };

          if (status.status === "failed") {
            outStatus.errors = status.errors.map((e) => e.message);

            for (const error of status.errors) {
              log.error(
                `WhatsApp status error for outgoing message id ${status.id}`,
                error.message,
              );
            }
          }

          if (status.status === "sent") {
            outStatus.conversation = {
              id: status.conversation.id,
              type: status.conversation.origin.type,
              expiration_timestamp: new Date(
                parseInt(status.conversation.expiration_timestamp) * 1000,
              ).toISOString(),
            };
          }

          statuses.push({
            external_id: status.id,
            status: outStatus,
          });
        }
      }
    }
  }

  const downloadMediaPromise = downloadMedia(mediaMessages, client);

  // Note: Tried with bulk upsert. It did not work. It expects values in all fields even for update.
  // Hence, using a custom RCP to perform bulk update.
  // Note 2: The order of these notifications may not reflect the actual timing of the message status.
  // Worry not, we took care of it.
  const statusesPromise = client.rpc("bulk_update_messages_status", {
    records: statuses,
  });

  conversations.forEach(
    (conv) => (conv.name = contacts.get(conv.contact_address!)),
  );

  const { error: conversationsError } = await client
    .from("conversations")
    .insert(Array.from(conversations) as ConversationInsert[]);

  if (conversationsError) throw conversationsError;

  // Download media before upserting incoming messages
  // Patched messages include media local id and file size
  const patchedMediaMessages = await downloadMediaPromise;

  const { error: incomingError } = await client
    .from("messages")
    .upsert(messages.concat(patchedMediaMessages), {
      ignoreDuplicates: true,
      onConflict: "external_id",
    });

  if (incomingError) throw incomingError;

  const { error: statusesError } = await statusesPromise;

  if (statusesError) throw statusesError;

  return new Response();
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
