import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import {
  createUnsecureClient,
  type EndpointMessage,
  type EndpointMessageResponse,
  type EndpointStatus,
  type EndpointStatusResponse,
  type MessageRow,
  type OutgoingMessage,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import { downloadFromStorage } from "../_shared/media.ts";
import { Json } from "../_shared/db_types.ts";

const API_VERSION = "v24.0";
const DEFAULT_ACCESS_TOKEN = Deno.env.get("META_SYSTEM_USER_ACCESS_TOKEN") ||
  "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

class WhatsAppError extends Error {
  constructor(
    message: string,
    options?: { cause?: { headers: unknown; body: unknown } },
  ) {
    super(message, options);
    this.name = "WhatsAppError";
  }
}

/** Uploads media to WA servers
 *
 * Allowed MIME types:
 *
 * Audio: up to 16 MB
 * - audio/aac
 * - audio/mp4
 * - audio/mpeg
 * - audio/amr
 * - audio/ogg
 * - audio/opus
 *
 * Documents: up to 100 MB
 * - application/vnd.ms-powerpoint
 * - application/msword
 * - application/vnd.openxmlformats-officedocument.wordprocessingml.document
 * - application/vnd.openxmlformats-officedocument.presentationml.presentation
 * - application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 * - application/pdf
 * - application/vnd.ms-excel
 * - text/plain
 *
 * Images: up to 5 MB
 * - image/jpeg
 * - image/png
 *
 * Sticker: animated 500 KB / static 100 KB
 * - image/webp
 *
 * Video: up to 16 MB
 * - video/mp4
 * - video/3gpp
 *
 * @param phone_number_id
 * @param media_id
 * @param mime_type
 * @param access_token
 * @returns WA media id
 */
async function uploadMediaItem({
  message,
  access_token,
  client,
}: {
  message: MessageRow;
  access_token: string;
  client: SupabaseClient;
}): Promise<MessageRow> {
  if (message.content.type !== "file") {
    return message;
  }

  let file = await downloadFromStorage(client, message.content.file.uri);

  let mime_type = message.content.file.mime_type;

  // make WA accept text/csv
  if (mime_type.startsWith("text/")) {
    mime_type = "text/plain";
    file = new Blob([file], { type: "text/plain" });
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("type", mime_type);
  formData.append("messaging_product", "whatsapp");

  const phone_number_id = message.organization_address;

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phone_number_id}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}` },
      body: formData,
    },
  );

  if (!response.ok) {
    throw new WhatsAppError("Could not upload media item to WhatsApp servers", {
      cause: {
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.json().catch(() => ({})),
      },
    });
  }

  const mediaMetadata = (await response.json()) as { id: string };

  message.content.file.uri = mediaMetadata.id;

  return message;
}

async function outgoingMessageToEndpointMessage({
  content,
  to,
}: {
  content: OutgoingMessage;
  to: string;
}): Promise<EndpointMessage> {
  const baseMessage = {
    messaging_product: "whatsapp" as const,
    recipient_type: "individual" as const,
    to,
    ...(content.kind !== "reaction" && // From the docs: You cannot send a reaction message as a contextual reply.
        content.re_message_id &&
        !content.forwarded
      ? { context: { message_id: content.re_message_id } }
      : {}),
  };

  switch (content.kind) {
    case "text": {
      return {
        ...baseMessage,
        type: "text",
        text: {
          body: content.text,
        },
      };
    }
    case "reaction": {
      return {
        ...baseMessage,
        type: "reaction",
        reaction: {
          emoji: content.text,
          message_id: content.re_message_id!,
        },
      };
    }
    case "audio": {
      return {
        ...baseMessage,
        type: "audio",
        audio: { id: content.file.uri },
      };
    }
    case "image": {
      return {
        ...baseMessage,
        type: "image",
        image: { id: content.file.uri, caption: content.text },
      };
    }
    case "video": {
      return {
        ...baseMessage,
        type: "video",
        video: { id: content.file.uri, caption: content.text },
      };
    }
    case "sticker": {
      return {
        ...baseMessage,
        type: "sticker",
        sticker: { id: content.file.uri },
      };
    }
    case "document": {
      return {
        ...baseMessage,
        type: "document",
        document: {
          id: content.file.uri,
          caption: content.text,
          filename: content.file.name,
        },
      };
    }
    case "contacts": {
      return {
        ...baseMessage,
        type: "contacts",
        contacts: content.data,
      };
    }
    case "location": {
      return {
        ...baseMessage,
        type: "location",
        location: content.data,
      };
    }
    case "template": {
      return {
        ...baseMessage,
        type: "template",
        template: content.data,
      };
    }
    default: {
      throw new Error(
        `Cannot convert outgoing message of type ${content.type} and kind ${content.kind}`,
      );
    }
  }
}

// Overload signatures
async function postPayloadToWhatsAppEndpoint(params: {
  payload: EndpointMessage;
  phone_number_id: string;
  access_token: string;
}): Promise<EndpointMessageResponse>;
async function postPayloadToWhatsAppEndpoint(params: {
  payload: EndpointStatus;
  phone_number_id: string;
  access_token: string;
}): Promise<EndpointStatusResponse>;

async function postPayloadToWhatsAppEndpoint({
  payload,
  phone_number_id,
  access_token,
}: {
  payload: EndpointMessage | EndpointStatus;
  phone_number_id: string;
  access_token: string;
}): Promise<EndpointMessageResponse | EndpointStatusResponse> {
  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phone_number_id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new WhatsAppError("Could not post payload to WhatsApp servers", {
      cause: {
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.json().catch(() => ({})),
      },
    });
  }

  return await response.json();
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();

  const message = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  log.info(`Dispatching message ${message.id}`, message);

  const { data: account } = await client
    .from("organizations_addresses")
    .select("extra->>access_token")
    .eq("address", message.organization_address)
    .single()
    .throwOnError();

  const access_token = account.access_token || DEFAULT_ACCESS_TOKEN;

  if (message.direction === "outgoing") {
    const patchedMessage = await uploadMediaItem({
      message,
      access_token,
      client,
    });

    const payload = await outgoingMessageToEndpointMessage({
      content: patchedMessage.content as OutgoingMessage,
      to: message.contact_address,
    });

    try {
      const response = await postPayloadToWhatsAppEndpoint({
        payload,
        phone_number_id: message.organization_address,
        access_token,
      });

      await client
        .from("messages")
        .update({
          external_id: response.messages[0].id,
          status: {
            [response.messages[0].message_status || "accepted"]: new Date()
              .toISOString(),
          },
        })
        .eq("id", message.id)
        .throwOnError();
    } catch (error) {
      if (!(error instanceof WhatsAppError)) {
        throw error;
      }

      await client
        .from("messages")
        .update({
          status: {
            failed: new Date().toISOString(),
            errors: [error.cause as Json],
          },
        })
        .eq("id", message.id)
        .throwOnError();
    }
  } else if (message.direction === "incoming") {
    let readReceipt = false;
    let typingIndicator = false;

    if (
      message.status.read &&
      Date.now() - +new Date(message.status.read) <= 60 * 1000
    ) {
      readReceipt = true;
    }

    if (
      message.status.typing &&
      Date.now() - +new Date(message.status.typing) <= 60 * 1000
    ) {
      typingIndicator = true;
    }

    log.info(
      `read receipt: ${readReceipt}, typing indicator: ${typingIndicator}`,
    );

    if (!readReceipt && !typingIndicator) {
      return new Response();
    }

    if (!message.external_id) {
      throw new Error(
        `Cannot mark message with id ${message.id} as read because its external_id is missing.`,
      );
    }

    const payload: EndpointStatus = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: message.external_id,
      ...(typingIndicator && {
        typing_indicator: {
          type: "text",
        },
      }),
    };

    const response = await postPayloadToWhatsAppEndpoint({
      payload,
      phone_number_id: message.organization_address,
      access_token,
    });
  } else {
    throw new Error(
      `Cannot dispatch message with id ${message.id} because its direction is not 'outgoing' nor 'incoming'.`,
    );
  }

  return new Response();
});
