import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import {
  createUnsecureClient,
  type IgAttachmentType,
  type IgEndpointMessage,
  type IgEndpointMessageResponse,
  type IgEndpointPayload,
  type IgErrorResponse,
  type IgReactionAction,
  type IgSenderAction,
  type MessageRow,
  type OutgoingMessage,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import { createSignedUrl } from "../_shared/media.ts";
import { commitDispatchedMessage } from "../_shared/dispatch.ts";
import { Json } from "../_shared/db_types.ts";

const API_VERSION = "v25.0";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

class InstagramError extends Error {
  constructor(
    message: string,
    options?: { cause?: { headers: unknown; body: unknown } | IgErrorResponse },
  ) {
    super(message, options);
    this.name = "InstagramError";
  }
}

/**
 * Instagram messaging error codes that are transient and should be retried.
 * Instagram returns the Graph API error envelope, which additionally carries an
 * `is_transient` flag; we honor that flag too (see classification below).
 *
 * Source: https://developers.facebook.com/docs/graph-api/guides/error-handling/
 *
 * Transient:
 *   1      API Unknown — possible server error
 *   2      API Service — temporary downtime/overload
 *   4      Application request limit reached
 *   613    Calls to this API have exceeded the rate limit
 *   80007  Rate limit issues
 *
 * Permanent (everything else), including:
 *   10     Permission / message sent outside the allowed 24-hour window (subcode 2534022)
 *   100    Invalid parameter
 *   190    Access token expired/invalid
 *   200    Permissions error
 *   551    User unavailable (opted out / removed the app)
 */
const RETRYABLE_META_CODES = new Set([1, 2, 4, 613, 80007]);

/**
 * Checks if a URI uses an external protocol (http/https). Internal storage
 * URIs (`internal://media/...`) must be resolved to a signed public URL before
 * Instagram can fetch them.
 */
function isExternalUri(uri: string): boolean {
  return uri.startsWith("http://") || uri.startsWith("https://");
}

/**
 * Resolves a message media URI into a public URL the Instagram CDN can fetch.
 * External URLs are passed through; internal storage URIs are turned into a
 * time-limited signed URL.
 */
async function resolveMediaUrl(
  client: SupabaseClient,
  uri: string,
): Promise<string> {
  if (isExternalUri(uri)) {
    return uri;
  }

  return await createSignedUrl(client, uri);
}

/**
 * Maps a message's media kind to the Instagram attachment type. WhatsApp's
 * "document" and the generic "media"/"file" kinds all map to Instagram's
 * "file". "sticker" has no Send API equivalent (only `like_heart`) and is
 * rejected by the caller.
 */
function toInstagramAttachmentType(kind: string): IgAttachmentType {
  switch (kind) {
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "document":
    case "file":
    case "media":
      return "file";
    default:
      throw new InstagramError(
        `Cannot send media of kind ${kind} to Instagram`,
      );
  }
}

/**
 * Converts an outgoing message into the ordered list of payloads to POST.
 * Most messages produce a single payload; a media message that also carries a
 * caption produces two (the attachment, then the caption as a separate text
 * message — Instagram attachments have no caption field).
 */
async function outgoingMessageToPayloads({
  content,
  to,
  client,
}: {
  content: OutgoingMessage;
  to: string;
  client: SupabaseClient;
}): Promise<Array<IgEndpointMessage | IgReactionAction>> {
  const recipient = { id: to };

  switch (content.kind) {
    case "text": {
      return [{ recipient, message: { text: content.text } }];
    }
    case "reaction": {
      if (!content.re_message_id) {
        throw new InstagramError(
          "Cannot send an Instagram reaction without re_message_id",
        );
      }
      // An empty emoji removes the reaction.
      return [
        content.text
          ? {
            recipient,
            sender_action: "react",
            payload: {
              message_id: content.re_message_id,
              reaction: content.text,
            },
          }
          : {
            recipient,
            sender_action: "unreact",
            payload: { message_id: content.re_message_id },
          },
      ];
    }
    case "audio":
    case "image":
    case "video":
    case "document":
    case "file":
    case "media": {
      const url = await resolveMediaUrl(client, content.file.uri);
      const type = toInstagramAttachmentType(content.kind);

      const payloads: Array<IgEndpointMessage | IgReactionAction> = [
        { recipient, message: { attachment: { type, payload: { url } } } },
      ];

      // Instagram has no caption field; deliver the caption as a follow-up text.
      if (content.text) {
        payloads.push({ recipient, message: { text: content.text } });
      }

      return payloads;
    }
    default: {
      throw new InstagramError(
        `Cannot convert outgoing message of type ${content.type} and kind ${content.kind} for Instagram`,
      );
    }
  }
}

async function postPayloadToInstagramEndpoint({
  payload,
  ig_user_id,
  access_token,
}: {
  payload: IgEndpointPayload;
  ig_user_id: string;
  access_token: string;
}): Promise<IgEndpointMessageResponse> {
  const response = await fetch(
    `https://graph.instagram.com/${API_VERSION}/${ig_user_id}/messages`,
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
    throw new InstagramError("Could not post payload to Instagram servers", {
      cause: await response.json().catch(() => ({})),
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

  if (!message.contact_address) {
    throw new Error(
      `Cannot dispatch message with id ${message.id} because contact_address is missing`,
    );
  }

  const { data: account } = await client
    .from("organizations_addresses")
    .select("extra->>access_token")
    .eq("organization_id", message.organization_id)
    .eq("address", message.organization_address)
    .single()
    .throwOnError();

  const access_token = account.access_token;

  if (!access_token) {
    throw new Error(
      `Cannot dispatch message with id ${message.id} because the Instagram access token is missing`,
    );
  }

  if (message.direction === "outgoing") {
    try {
      const content = message.content as OutgoingMessage;

      const payloads = await outgoingMessageToPayloads({
        content,
        to: message.contact_address,
        client,
      });

      const responses: IgEndpointMessageResponse[] = [];
      for (const payload of payloads) {
        responses.push(
          await postPayloadToInstagramEndpoint({
            payload,
            ig_user_id: message.organization_address,
            access_token,
          }),
        );
      }

      // Reactions and sender actions do not return a message id to track; only
      // genuine message sends do (the first payload, when not a reaction).
      const external_id = content.kind === "reaction"
        ? undefined
        : responses[0]?.message_id;

      await commitDispatchedMessage({
        client,
        messageId: message.id,
        externalId: external_id,
        status: { accepted: new Date().toISOString() },
      });
    } catch (error) {
      const isInstagramError = error instanceof InstagramError;
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      const igError = isInstagramError
        ? (error.cause as IgErrorResponse | undefined)?.error
        : undefined;
      const metaCode = igError?.code;
      const isRetryable = igError?.is_transient === true ||
        (metaCode != null && RETRYABLE_META_CODES.has(metaCode));
      const errorDetail: Json = isInstagramError
        ? (error.cause as Json)
        : errorMessage;

      if (isRetryable) {
        // Transient: record the error for user visibility but keep retryable (no
        // "failed" key). The merge_update trigger overwrites the errors array on
        // each retry.
        log.warn("Dispatch failed (transient, will retry)", {
          message_id: message.id,
          code: metaCode,
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

      // Permanent: mark as failed to stop retries.
      log.error("Dispatch failed (permanent)", {
        message_id: message.id,
        code: metaCode,
        error: errorMessage,
      });

      await client
        .from("messages")
        .update({
          status: {
            failed: new Date().toISOString(),
            errors: [errorDetail],
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

    // Instagram sender actions must be sent one at a time, each carrying only
    // the recipient and the action (no message_id, unlike WhatsApp's read mark).
    const recipient = { id: message.contact_address };

    if (readReceipt) {
      const payload: IgSenderAction = { recipient, sender_action: "mark_seen" };
      await postPayloadToInstagramEndpoint({
        payload,
        ig_user_id: message.organization_address,
        access_token,
      });
    }

    if (typingIndicator) {
      const payload: IgSenderAction = { recipient, sender_action: "typing_on" };
      await postPayloadToInstagramEndpoint({
        payload,
        ig_user_id: message.organization_address,
        access_token,
      });
    }
  } else {
    throw new Error(
      `Cannot dispatch message with id ${message.id} because its direction is not 'outgoing' nor 'incoming'.`,
    );
  }

  return new Response();
});
