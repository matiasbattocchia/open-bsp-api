import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import {
  createClient,
  type WebhookPayload,
  type MessageRow,
  MediaTypes,
  type EndpointMessage,
  type EndpointStatus,
} from "../_shared/supabase.ts";
import { downloadFromStorage } from "../_shared/media.ts";

const API_VERSION = "v23.0";
const DEFAULT_ACCESS_TOKEN =
  Deno.env.get("META_SYSTEM_USER_ACCESS_TOKEN") || "";

/** Uploads media to WA servers
 *
 * @param phone_number_id
 * @param media_id
 * @param mime_type
 * @param access_token
 * @returns WA media id
 */
async function uploadMediaItem(
  phone_number_id: string,
  uri: string,
  mime_type: string,
  access_token: string,
  client: SupabaseClient
): Promise<string> {
  const file = await downloadFromStorage(client, uri);

  const formData = new FormData();
  formData.append("file", file);
  formData.append("type", mime_type);
  formData.append("messaging_product", "whatsapp");

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phone_number_id}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}` },
      body: formData,
    }
  );

  if (!response.ok) {
    log.error(response.headers.get("www-authenticate")!);
    throw response;
  }

  return (await response.json()).id as string;
}

Deno.serve(async (request) => {
  const client = createClient(request);

  const record = ((await request.json()) as WebhookPayload<MessageRow>).record!;

  if (!["internal", "whatsapp"].includes(record.service)) {
    throw new Error(
      `Dispatch for '${record.service}' service is not implemented!`
    );
  }

  if (record.service === "local" && record.type === "outgoing") {
    await client
      .from("messages")
      .update({
        status: {
          delivered: new Date().toISOString(),
        },
      })
      .eq("id", record.id);

    return new Response();
  }

  if (Deno.env.get("ENV") === "DEV") {
    log.info("Dispatcher function skipped because ENV env var is set to DEV.");

    if (record.type === "outgoing") {
      await client
        .from("messages")
        .update({
          status: {
            sent: new Date().toISOString(),
          },
        })
        .eq("id", record.id);
    }

    return new Response();
  }

  const { data: account, error: queryError } = await client
    .from("organizations_addresses")
    .select("extra->>access_token")
    .eq("address", record.organization_address)
    .single();

  if (queryError) throw queryError;

  account.access_token ||= DEFAULT_ACCESS_TOKEN;

  let message: EndpointMessage | EndpointStatus;

  if (record.direction === "outgoing") {
    message = await outgoingMessage(record, account.access_token, client);
  } else if (record.direction === "incoming") {
    let readReceipt = false;
    let typingIndicator = false;

    if (record.status.read) {
      if (Date.now() - +new Date(record.status.read) <= 60 * 1000) {
        readReceipt = true;
      }
    }

    if (record.status.typing) {
      if (Date.now() - +new Date(record.status.typing) <= 60 * 1000) {
        typingIndicator = true;
      }
    }

    if (!readReceipt && !typingIndicator) {
      return new Response();
    }

    if (!record.external_id) {
      throw new Error(
        `Cannot mark message with id ${record.id} as read because its external_id is missing.`
      );
    }

    message = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: record.external_id,
      ...(typingIndicator && {
        typing_indicator: {
          type: "text",
        },
      }),
    };
  } else {
    throw new Error(
      `Cannot dispatch message with id ${record.id} because its direction is not 'outgoing' or 'incoming'.`
    );
  }

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${record.organization_address}/messages`, // org address is the WA phone_number_id
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    }
  );

  if (!response.ok) {
    const errorMessage = response.headers.get("www-authenticate") || "";

    log.error(errorMessage);

    if (record.type === "outgoing") {
      const { error: updateError } = await client
        .from("messages")
        .update({
          status: {
            failed: new Date().toISOString(),
            errors: [errorMessage],
          },
        })
        .eq("id", record.id);

      if (updateError) {
        log.error(
          `Could not update status of outgoing message with id ${record.id}`,
          updateError
        );
      }
    }

    throw response;
  }

  /** Mark as read / Read receipt successful response
   * {
   *   "success": true
   * }
   */

  // TODO: a successful response has this payload
  // {
  //   "messaging_product": "whatsapp",
  //   "contacts": [
  //     {
  //       "input": "16505076520",
  //       "wa_id": "16505076520"
  //     }
  //   ],
  //   "messages": [
  //     {
  //       "id": "wamid.HBgLMTY1MDUwNzY1MjAVAgARGBI5QTNDQTVCM0Q0Q0Q2RTY3RTcA".
  //       "message_status": "accepted",
  //     }
  //   ]
  // }
  // where `input` is the real receiver's phone number; `wa_id` might differ.
  // 1. [ ] Save the input as user phone number.
  // 2. [x] Replace (update) outgoing message UUID with WAMID.
  // 3. [ ] User identity hash might be present in the response as well.
  // 4. [x] "message_status":"held_for_quality_assessment": means the message send was delayed until quality can be validated and it will either be sent or dropped at this point
  const endpointPayload = await response.json();

  if (endpointPayload.messages) {
    const { error: updateError } = await client
      .from("messages")
      .update({
        external_id: endpointPayload.messages[0].id,
        status: {
          [endpointPayload.messages[0].message_status || "accepted"]:
            new Date().toISOString(),
        },
      })
      .eq("id", record.id);

    if (updateError) {
      log.error(
        `Could not update status of outgoing message with id ${record.id}`,
        updateError
      );
    }
  }

  return new Response();
});

async function outgoingMessage(
  record: MessageRow,
  access_token: string,
  client: SupabaseClient
) {
  if (record.direction !== "outgoing") {
    throw new Error(
      `Cannot dispatch outgoing message with id ${record.id} because its direction is not 'outgoing'!`
    );
  }

  const outMessage = record.message;
  let uploadedMediaID = "";

  // @ts-expect-error Argument of type 'string' is not assignable to parameter of type "audio" | "document" | "image" | "video" | "sticker"
  if (MediaTypes.includes(outMessage.type)) {
    if (outMessage.media?.url) {
      // Do nothing
    } else {
      if (!outMessage.media?.id || !outMessage.media?.mime_type) {
        throw new Error(
          `Could not upload media for message with id ${record.id}. Missing media_id or mime_type.`
        );
      }

      uploadedMediaID = await uploadMediaItem(
        record.organization_address,
        outMessage.media.id,
        outMessage.media.mime_type,
        access_token,
        client
      );
    }
  }

  const message: Partial<EndpointMessage> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: record.contact_address,
    type: outMessage.type,
  };

  if (
    outMessage.type !== "reaction" && // From the docs: You cannot send a reaction message as a contextual reply.
    outMessage.re_message_id &&
    !outMessage.forwarded
  ) {
    message.context = { message_id: outMessage.re_message_id };
  }

  switch (message.type) {
    case "text":
      if (!outMessage.content) {
        throw new Error(
          `Cannot dispatch outgoing message with id ${record.id} of type 'text' because its content is missing!`
        );
      }

      message.text = { body: outMessage.content };
      break;
    case "reaction":
      if (!outMessage.re_message_id) {
        throw new Error(
          `Cannot dispatch outgoing message with id ${record.id} of type 'reaction' because its re_message_id is missing!`
        );
      }

      message.reaction = {
        emoji: outMessage.content || "",
        message_id: outMessage.re_message_id,
      };
      break;
    case "contacts":
      // @ts-expect-error Property does not exist
      message.contacts = outMessage.contacts;
      break;
    /*case "interactive":
      // @ts-expect-error Property does not exist
      message.interactive = outMessage.interactive;
      break;*/
    case "location":
      // @ts-expect-error Property does not exist
      message.location = outMessage.location;
      break;
    case "template":
      // @ts-expect-error Property does not exist
      message.template = outMessage.template;
      break;
    case "audio":
      message.audio = { id: uploadedMediaID };
      break;
    case "document":
      message.document = {
        ...(outMessage.content && { caption: outMessage.content }),
        ...(outMessage.media?.url
          ? { link: outMessage.media.url }
          : { id: uploadedMediaID }),
      };
      break;
    case "image":
      message.image = {
        ...(outMessage.content && { caption: outMessage.content }),
        ...(outMessage.media?.url
          ? { link: outMessage.media.url }
          : { id: uploadedMediaID }),
      };
      break;
    case "sticker":
      message.sticker = { id: uploadedMediaID };
      break;
    case "video":
      message.video = {
        ...(outMessage.content && { caption: outMessage.content }),
        ...(outMessage.media?.url
          ? { link: outMessage.media.url }
          : { id: uploadedMediaID }),
      };
      break;
    default:
      throw new Error(
        `Dispatch for '${record.service}' service does not know how to handle message of type ${outMessage.type}!`
      );
  }

  return message as EndpointMessage;
}
