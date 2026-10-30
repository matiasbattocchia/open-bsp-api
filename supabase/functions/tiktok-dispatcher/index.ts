import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import {
  createUnsecureClient,
  type Database,
  type IncomingStatus,
  type MessageRow,
  type OutgoingMessage,
  type TikTokOrganizationAddressExtra,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import { downloadFromStorage, fetchMedia } from "../_shared/media.ts";
import { commitDispatchedMessage } from "../_shared/dispatch.ts";
import {
  ensureFreshToken,
  flagExpiredToken,
  isDeadToken,
  isRateLimited,
  sendMessage,
  TikTokError,
  type TikTokSendBody,
  uploadImage,
} from "../_shared/tiktok.ts";
import { Json } from "../_shared/db_types.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// TikTok takes JPG and PNG images up to 3 MB.
const IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);
const MAX_IMAGE_SIZE = 3 * 1024 * 1024;

type Client = SupabaseClient<Database>;

/** A refusal that sending again won't change. */
class UnsendableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsendableError";
  }
}

/** An image's bytes, from our storage or from an external URL. */
async function readImage(client: Client, uri: string): Promise<Blob> {
  return uri.startsWith("http://") || uri.startsWith("https://")
    ? await fetchMedia(uri)
    : await downloadFromStorage(client, uri);
}

/**
 * The sends an outgoing message takes, in order. An image with a caption is
 * two: TikTok's images have no caption, so it follows as text. TikTok sends
 * text, images and the account's own posts; it sends no reactions, audio,
 * video or documents.
 */
async function toSends({
  client,
  content,
  business_id,
  access_token,
}: {
  client: Client;
  content: OutgoingMessage;
  business_id: string;
  access_token: string;
}): Promise<TikTokSendBody[]> {
  switch (content.kind) {
    case "text":
      return [{
        message_type: "TEXT",
        text: { body: content.text },
        ...(content.re_message_id && {
          referenced_message_info: {
            referenced_message_id: content.re_message_id,
          },
        }),
      }];
    case "image": {
      const file = await readImage(client, content.file.uri);
      const type = file.type || content.file.mime_type;

      if (!IMAGE_TYPES.has(type)) {
        throw new UnsendableError(
          `TikTok only sends JPG and PNG images, not ${type}`,
        );
      }

      if (file.size > MAX_IMAGE_SIZE) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        throw new UnsendableError(
          `TikTok sends images up to 3 MB; this one is ${sizeMB} MB`,
        );
      }

      const media_id = await uploadImage(
        business_id,
        access_token,
        file,
        content.file.name ?? (type === "image/png" ? "image.png" : "image.jpg"),
      );

      return [
        { message_type: "IMAGE", image: { media_id } },
        ...(content.text
          ? [{ message_type: "TEXT" as const, text: { body: content.text } }]
          : []),
      ];
    }
    case "share": {
      if (content.data.type !== "tiktok_post" || !content.data.item_id) {
        throw new UnsendableError("TikTok only shares its own posts");
      }

      return [{
        message_type: "SHARE_POST",
        share_post: { item_id: content.data.item_id },
      }];
    }
    case "reaction":
      throw new UnsendableError("TikTok can't send reactions");
    case "audio":
    case "video":
    case "document":
    case "sticker":
    case "file":
    case "media":
      throw new UnsendableError(
        `TikTok can't send ${content.kind} files, only images`,
      );
    default:
      throw new UnsendableError(
        `TikTok can't send messages of type ${content.type} and kind ${content.kind}`,
      );
  }
}

Deno.serve(async (req) => {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();

  const message = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  log.info(`Dispatching message ${message.id}`, message);

  // TikTok sends to a conversation, not to a person: the webhook keeps its id
  // on the conversation.
  const { data: conversation } = await client
    .from("conversations")
    .select("extra->>tiktok_conversation_id")
    .eq("id", message.conversation_id)
    .single()
    .throwOnError();

  const { data: account } = await client
    .from("organizations_addresses")
    .select("extra")
    .eq("organization_id", message.organization_id)
    .eq("service", "tiktok")
    .eq("address", message.organization_address)
    .single()
    .throwOnError();

  const business_id = message.organization_address;
  const conversation_id = conversation.tiktok_conversation_id;

  // Authorship decides the job: a row the account itself wrote (sender null)
  // is a send; a contact's row only ever comes here for read receipts.
  if (message.sender_address === null) {
    try {
      if (!conversation_id) {
        throw new UnsendableError(
          "The conversation has no TikTok conversation id: TikTok only lets a business answer a customer who wrote first",
        );
      }

      const access_token = await ensureFreshToken(
        client,
        message.organization_id,
        business_id,
        account.extra as TikTokOrganizationAddressExtra,
      ).catch((error) => {
        throw error instanceof TikTokError
          ? error
          : new UnsendableError(error.message);
      });

      const sends = await toSends({
        client,
        content: message.content as OutgoingMessage,
        business_id,
        access_token,
      });

      const ids: (string | undefined)[] = [];
      for (const body of sends) {
        ids.push(
          await sendMessage(business_id, conversation_id, access_token, body),
        );
      }

      await commitDispatchedMessage({
        client,
        messageId: message.id,
        externalId: ids[0],
        status: { accepted: new Date().toISOString() },
      });
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      const errorDetail: Json = error instanceof TikTokError && error.cause
        ? error.cause as Json
        : errorMessage;

      // Throttled, TikTok down or out of reach (fetch's TypeError): worth
      // another try.
      const retryable = isRateLimited(error) ||
        error instanceof TypeError ||
        (error instanceof TikTokError && error.code === undefined &&
          (error.status === undefined || error.status >= 500));

      if (retryable) {
        // Keep the row armed (no `failed`); the merge_update trigger
        // overwrites the errors array on each retry.
        log.warn("Dispatch failed (transient, will retry)", {
          message_id: message.id,
          error: errorMessage,
        });

        await client
          .from("messages")
          .update({ status: { errors: [errorDetail] } })
          .eq("id", message.id)
          .throwOnError();

        // Rethrow so the function returns 500 and the cron retries.
        throw error;
      }

      // Permanent — including TikTok's message window and quota refusals,
      // which say why in errorDetail.
      log.error("Dispatch failed (permanent)", {
        message_id: message.id,
        error: errorMessage,
      });

      if (isDeadToken(error)) {
        await flagExpiredToken(client, message.organization_id, business_id);
      }

      await client
        .from("messages")
        .update({
          status: {
            // Terminal, so the arm bit goes with it — same reason
            // commitDispatchedMessage retracts on success.
            pending: null,
            failed: new Date().toISOString(),
            errors: [errorDetail],
          },
        })
        .eq("id", message.id)
        .throwOnError();
    }

    return new Response();
  }

  // A contact's row: the only status that dispatches back is our read. A
  // direct-chat read is scalar; a map (per-member team-chat reads) is not a
  // receipt owed to this service's peer.
  const status = message.status as IncomingStatus;
  const readReceipt = typeof status.read === "string" &&
    Date.now() - +new Date(status.read) <= 60 * 1000;

  log.info(`read receipt: ${readReceipt}`);

  if (!readReceipt || !conversation_id) return new Response();

  const access_token = await ensureFreshToken(
    client,
    message.organization_id,
    business_id,
    account.extra as TikTokOrganizationAddressExtra,
  );

  try {
    await sendMessage(business_id, conversation_id, access_token, {
      message_type: "SENDER_ACTION",
      sender_action: "MARK_READ",
    });
  } catch (error) {
    if (isDeadToken(error)) {
      await flagExpiredToken(client, message.organization_id, business_id);
    }

    throw error;
  }

  return new Response();
});
