import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import {
  type CommentPart,
  type ContactAddressInsert,
  createUnsecureClient,
  type Database,
  type IncomingMessage,
  type MessageInsert,
  type OrganizationAddressRow,
  type OutgoingMessage,
  type TikTokCommentEvent,
  type TikTokContactAddressExtra,
  type TikTokDirectMessage,
  type TikTokOrganizationAddressExtra,
  type TikTokWebhookParticipant,
  type TikTokWebhookPayload,
} from "../_shared/supabase.ts";
import {
  downloadMedia,
  ensureFreshToken,
  flagExpiredToken,
  getComment,
  getVideo,
  isDeadToken,
  isTransient,
  listParticipants,
  quoteIds,
  type TikTokComment,
  type TikTokVideo,
  verifySignature,
} from "../_shared/tiktok.ts";
import {
  fetchMedia,
  logUnstored,
  MAX_STORAGE_UPLOAD_SIZE,
  storePostThumbnail,
  uploadToStorage,
  withoutMedia,
} from "../_shared/media.ts";

// 24 hours. Profile is refreshed when older than this, as Instagram's.
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

const REGION_TEXT =
  "TikTok doesn't share messages from the EEA, Switzerland or the UK.";

type Client = SupabaseClient<Database>;

/** A DM image or video, as media/download takes it. */
type TikTokMedia = {
  media_id: string;
  media_type: "IMAGE" | "VIDEO";
  message_id: string;
};

/** What one webhook POST is about, once the envelope is read. */
type Event = {
  name: string;
  account: OrganizationAddressRow;
  message: TikTokDirectMessage;
  /** The customer: the person on the other side of the conversation. */
  customer: string;
  /** The customer's username, when the event says it. */
  username?: string;
  /** Whether the business wrote it (im_send_msg). */
  outgoing: boolean;
  timestamp: string;
};

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await request.text();

  // TikTok retries any non-200 for 72 hours, so a refusal here is retried
  // until the secret is right.
  if (!(await verifySignature(body, request.headers.get("TikTok-Signature")))) {
    log.warn("Invalid TikTok webhook signature");
    return new Response("Invalid signature", { status: 403 });
  }

  const payload = JSON.parse(quoteIds(body)) as TikTokWebhookPayload;
  const client = createUnsecureClient();

  if (payload.event === "comment.update") {
    await persistComment(client, payload);
    return new Response();
  }

  const event = await readEvent(client, payload);
  if (!event) return new Response();

  await persist(client, event);

  return new Response();
});

function isPersonal(participant?: TikTokWebhookParticipant): boolean {
  return participant?.role?.toLowerCase() === "personal_account";
}

function readContent<T>(payload: TikTokWebhookPayload): T {
  return (
    typeof payload.content === "string"
      ? JSON.parse(payload.content)
      : payload.content ?? {}
  ) as T;
}

/** The connected account an event is for, if any. */
async function findAccount(
  client: Client,
  payload: TikTokWebhookPayload,
): Promise<OrganizationAddressRow | undefined> {
  const { data: account } = await client
    .from("organizations_addresses")
    .select()
    .eq("service", "tiktok")
    .eq("address", payload.user_openid ?? "")
    .eq("status", "connected")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
    .throwOnError();

  if (!account) {
    log.warn("No connected TikTok account for webhook", {
      user_openid: payload.user_openid,
      event: payload.event,
    });
  }

  return account ?? undefined;
}

/**
 * Reads the envelope: which account it's for, who the customer is and when.
 * Events that carry no message, or are for an account not connected here,
 * come back empty.
 */
async function readEvent(
  client: Client,
  payload: TikTokWebhookPayload,
): Promise<Event | undefined> {
  const name = payload.event ?? "";

  if (!["im_receive_msg", "im_send_msg", "im_receive_msg_eu"].includes(name)) {
    log.info("Unhandled TikTok webhook event", { event: name });
    return undefined;
  }

  const message = readContent<TikTokDirectMessage>(payload);

  const account = await findAccount(client, payload);
  if (!account) return undefined;

  const outgoing = name === "im_send_msg";
  const peer = outgoing ? message.to_user : message.from_user;
  const customer = (isPersonal(peer) && peer?.id) || message.unique_identifier;

  if (!customer || !message.conversation_id) {
    log.warn("TikTok webhook without a customer or a conversation", {
      event: name,
      message_id: message.message_id,
    });
    return undefined;
  }

  const ms = message.timestamp ??
    (payload.create_time ? payload.create_time * 1000 : Date.now());

  return {
    name,
    account,
    message,
    customer,
    username: (outgoing ? message.to : message.from) || undefined,
    outgoing,
    timestamp: new Date(ms).toISOString(),
  };
}

/**
 * The content of a direct message. Images and videos come back as files
 * whose bytes are still at TikTok (see `media`); stickers and emoji carry a
 * public URL.
 */
function toContent(
  message: TikTokDirectMessage,
  media: Map<string, TikTokMedia>,
): IncomingMessage {
  const base = {
    version: "1" as const,
    ...(message.referenced_message_info?.referenced_message_id && {
      re_message_id: message.referenced_message_info.referenced_message_id,
    }),
  };

  const type = message.type?.toLowerCase();
  const message_id = message.message_id ?? "";

  switch (type) {
    case "text": {
      const text = message.text?.body ?? "";
      const button = message.reply_source_payload;

      // A click on a Q&A card's button arrives as the button's text.
      if (button) {
        return {
          ...base,
          type: "data",
          kind: "interactive",
          data: {
            type: "button_reply",
            button_reply: {
              id: button.reply_source_unique_id ?? text,
              title: text,
            },
          },
          text,
        };
      }

      return { ...base, type: "text", kind: "text", text };
    }
    case "image":
    case "video": {
      const media_id = (type === "image" ? message.image : message.video)
        ?.media_id;
      if (!media_id) break;

      media.set(message_id, {
        media_id,
        media_type: type === "image" ? "IMAGE" : "VIDEO",
        message_id,
      });

      return {
        ...base,
        type: "file",
        kind: type,
        file: {
          // Corrected from the download's Content-Type.
          mime_type: type === "image" ? "image/jpeg" : "video/mp4",
          uri: `tiktok-media:${media_id}`,
          size: 0,
        },
      };
    }
    case "sticker":
    case "emoji": {
      const url = (type === "sticker" ? message.sticker : message.emoji)?.url;
      if (!url) break;

      return {
        ...base,
        type: "file",
        kind: "sticker",
        file: { mime_type: "image/png", uri: url, size: 0 },
      };
    }
    case "share_post": {
      const url = message.share_post?.embed_url;
      if (!url) break;

      return {
        ...base,
        type: "data",
        kind: "share",
        data: {
          type: "tiktok_post",
          url,
          ...(message.share_post?.video_id && {
            item_id: message.share_post.video_id,
          }),
        },
      };
    }
    case "template": {
      // A Q&A card the business sent, from the TikTok app or an auto message:
      // the question and its answers, as they read.
      const template = message.template;
      const lines = [
        template?.title,
        ...(template?.buttons ?? []).map((button) => `• ${button.title}`),
      ].filter(Boolean);

      return { ...base, type: "text", kind: "text", text: lines.join("\n") };
    }
  }

  return {
    ...base,
    type: "data",
    kind: "unsupported",
    data: { type: "other" },
    text: `TikTok message of type ${message.type ?? "unknown"}`,
  };
}

/** The rows one event becomes: a message, or one row per reaction. */
function toRows(
  event: Event,
  media: Map<string, TikTokMedia>,
): { messages: MessageInsert[]; statuses: MessageInsert[] } {
  const { account, message, customer, outgoing, timestamp } = event;

  const addressing = {
    organization_id: account.organization_id,
    service: "tiktok" as const,
    organization_address: account.address,
    conversation_address: customer,
  };

  if (event.name === "im_receive_msg_eu") {
    return {
      messages: [{
        ...addressing,
        external_id: message.message_id ||
          `${message.conversation_id}#region#${timestamp}`,
        sender_address: customer,
        content: {
          version: "1",
          type: "data",
          kind: "unsupported",
          data: { type: "region" },
          text: REGION_TEXT,
        },
        timestamp,
      }],
      statuses: [],
    };
  }

  if (message.type?.toLowerCase() === "reaction") {
    return {
      messages: (message.reaction ?? [])
        .filter((reaction) => reaction.original_msg_id)
        .map((reaction) => {
          const reactor = reaction.unique_identifier || customer;
          const at = reaction.timestamp
            ? new Date(reaction.timestamp).toISOString()
            : timestamp;

          return {
            ...addressing,
            external_id:
              `${reaction.original_msg_id}#reaction#${reactor}#${at}`,
            // The business reacting, from the TikTok app, is the account's.
            ...(!outgoing && { sender_address: reactor }),
            content: {
              version: "1",
              type: "data",
              kind: "reaction",
              data: reaction.operation === "REMOVE"
                ? { action: "removed" }
                : reaction.type === "AI_EMOJI"
                ? { action: "added", name: "ai_emoji" }
                : {
                  action: "added",
                  name: reaction.emoji,
                  unicode: reaction.emoji,
                },
              re_message_id: reaction.original_msg_id,
            } as IncomingMessage,
            ...(outgoing && { status: { sent: at } }),
            timestamp: at,
          };
        }),
      statuses: [],
    };
  }

  if (!message.message_id) return { messages: [], statuses: [] };

  if (outgoing) {
    // Our own API sends are already rows: the echo only confirms them. Sends
    // from the TikTok app (or its auto messages) are new rows of the
    // account's.
    if (message.message_tag?.source === "API") {
      return {
        messages: [],
        statuses: [{
          ...addressing,
          external_id: message.message_id,
          content: {} as OutgoingMessage, // {} is a no-op under merge_update
          status: { sent: timestamp },
        }],
      };
    }

    return {
      messages: [{
        ...addressing,
        external_id: message.message_id,
        content: toContent(message, media) as OutgoingMessage,
        status: { sent: timestamp },
        timestamp,
      }],
      statuses: [],
    };
  }

  return {
    messages: [{
      ...addressing,
      external_id: message.message_id,
      sender_address: customer,
      content: toContent(message, media),
      timestamp,
    }],
    statuses: [],
  };
}

/**
 * Makes sure the conversation exists and knows TikTok's id for it before any
 * message lands — the dispatcher sends to that id, and an agent may answer
 * the moment the message is in.
 */
async function ensureConversation(client: Client, event: Event) {
  const conversation_id = event.message.conversation_id!;
  const identity = {
    organization_id: event.account.organization_id,
    service: "tiktok" as const,
    organization_address: event.account.address,
    address: event.customer,
  };

  const { data: existing } = await client
    .from("conversations")
    .select("id, extra->>tiktok_conversation_id")
    .match(identity)
    .maybeSingle()
    .throwOnError();

  if (existing?.tiktok_conversation_id === conversation_id) return;

  if (!existing) {
    // A concurrent webhook may mint it first; then update theirs below.
    const { data: inserted } = await client
      .from("conversations")
      .upsert(
        { ...identity, extra: { tiktok_conversation_id: conversation_id } },
        {
          onConflict: "organization_id,organization_address,service,address",
          ignoreDuplicates: true,
        },
      )
      .select("id")
      .throwOnError();

    if (inserted?.length) return;
  }

  // merge_update keeps the other extra keys.
  await client
    .from("conversations")
    .update({ extra: { tiktok_conversation_id: conversation_id } })
    .match(identity)
    .throwOnError();
}

/**
 * The customer's address-book entry: the username every event carries, and
 * the display name and avatar fetched once a day (the fetch time is written
 * whether it worked or not, so a failing fetch isn't retried on every
 * message).
 */
async function contactRow(
  client: Client,
  event: Event,
): Promise<ContactAddressInsert | undefined> {
  const { account, customer, username } = event;

  const { data: cached } = await client
    .from("contacts_addresses")
    .select("extra")
    .eq("organization_id", account.organization_id)
    .eq("organization_address", account.address)
    .eq("service", "tiktok")
    .eq("address", customer)
    .maybeSingle()
    .throwOnError();

  const extra = (cached?.extra ?? {}) as TikTokContactAddressExtra;
  const fetchedAt = extra.name_fetched_at
    ? Date.parse(extra.name_fetched_at)
    : 0;
  const stale = Date.now() - fetchedAt >= PROFILE_TTL_MS;

  if (!stale && (!username || username === extra.username)) return undefined;

  const update: TikTokContactAddressExtra = {
    ...(username && { username }),
  };

  if (stale) {
    update.name_fetched_at = new Date().toISOString();

    try {
      const access_token = await ensureFreshToken(
        client,
        account.organization_id,
        account.address,
        account.extra as TikTokOrganizationAddressExtra,
      );
      const participants = await listParticipants(
        account.address,
        event.message.conversation_id!,
        access_token,
      );
      const person = participants.find((p) => p.id === customer) ??
        participants.find((p) => isPersonal(p as TikTokWebhookParticipant));

      if (person?.display_name) update.name = person.display_name;
      if (person?.profile_image) {
        update.profile_picture_url = person.profile_image;
      }
    } catch (error) {
      log.warn("Could not fetch the TikTok contact's profile", {
        customer,
        error: error instanceof Error ? error.message : String(error),
      });

      // Webhooks keep coming after the owner revokes the app, so this is
      // where a dead token shows first.
      if (isDeadToken(error)) {
        await flagExpiredToken(
          client,
          account.organization_id,
          account.address,
        );
      }
    }
  }

  return {
    organization_id: account.organization_id,
    organization_address: account.address,
    service: "tiktok",
    address: customer,
    extra: update,
  };
}

/**
 * Stores a file's bytes: a DM image or video through TikTok's download (it
 * takes the account's token), a sticker or emoji from its public URL. A
 * failure, or a file over the upload limit, leaves a media_placeholder.
 */
async function downloadMediaItem(
  client: Client,
  event: Event,
  message: MessageInsert,
  media: Map<string, TikTokMedia>,
): Promise<MessageInsert> {
  if (message.content.type !== "file") return message;

  try {
    const item = media.get(message.external_id ?? "");
    let file: Blob;

    if (item) {
      const access_token = await ensureFreshToken(
        client,
        event.account.organization_id,
        event.account.address,
        event.account.extra as TikTokOrganizationAddressExtra,
      );

      file = await downloadMedia(access_token, {
        business_id: event.account.address,
        conversation_id: event.message.conversation_id!,
        ...item,
      });
    } else {
      file = await fetchMedia(message.content.file.uri);
    }

    message.content.file.size = file.size;
    if (file.type) message.content.file.mime_type = file.type;

    if (file.size > MAX_STORAGE_UPLOAD_SIZE) {
      const sizeMB = (file.size / (1000 * 1000)).toFixed(1);
      const limitMB = (MAX_STORAGE_UPLOAD_SIZE / (1000 * 1000)).toFixed(0);

      return withoutMedia(
        message,
        `File too large: ${sizeMB} MB (limit: ${limitMB} MB)`,
      );
    }

    message.content.file.uri = await uploadToStorage(
      client,
      event.account.organization_id,
      file,
      message.content.file.name,
    );

    return message;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    logUnstored(
      "Failed to download TikTok media, storing a placeholder",
      error,
      {
        message_id: message.external_id,
      },
    );

    if (isDeadToken(error)) {
      await flagExpiredToken(
        client,
        event.account.organization_id,
        event.account.address,
      );
    }

    return withoutMedia(message, reason);
  }
}

async function persist(client: Client, event: Event) {
  const media = new Map<string, TikTokMedia>();
  const { messages, statuses } = toRows(event, media);

  if (messages.length === 0 && statuses.length === 0) return;

  await ensureConversation(client, event);

  const contact = await contactRow(client, event);

  if (contact) {
    await client.from("contacts_addresses").upsert(contact).throwOnError();
  }

  const downloaded = await Promise.all(
    messages.map((message) => downloadMediaItem(client, event, message, media)),
  );

  log.info("TikTok webhook processing summary", {
    event: event.name,
    organization_id: event.account.organization_id,
    messages: downloaded.length,
    statuses: statuses.length,
  });

  // Statuses and messages go in separate statements: Postgres' ON CONFLICT
  // cannot affect the same row twice in one (see instagram-webhook).
  for (const rows of [statuses, downloaded]) {
    if (rows.length === 0) continue;

    await client
      .from("messages")
      .upsert(rows, { onConflict: "external_id" })
      .throwOnError();
  }
}

// Comments

/**
 * The comment as TikTok's API has it (who wrote it, whether the account did)
 * and the post it is on. Throttled, or with TikTok down, the webhook fails
 * and TikTok sends it again; refused otherwise, it is read as the webhook
 * has it.
 */
async function readComment(
  client: Client,
  account: OrganizationAddressRow,
  comment_id: string,
  video_id: string,
): Promise<{ comment?: TikTokComment; video?: TikTokVideo }> {
  try {
    const access_token = await ensureFreshToken(
      client,
      account.organization_id,
      account.address,
      account.extra as TikTokOrganizationAddressExtra,
    );

    const [comment, video] = await Promise.all([
      getComment(account.address, video_id, comment_id, access_token),
      getVideo(account.address, video_id, access_token).catch((error) => {
        log.warn("Could not read the TikTok post", {
          video_id,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }),
    ]);

    return { comment, video };
  } catch (error) {
    if (isTransient(error)) throw error;

    log.warn("Could not read the TikTok comment; taking the webhook's word", {
      comment_id,
      error: error instanceof Error ? error.message : String(error),
    });

    if (isDeadToken(error)) {
      await flagExpiredToken(client, account.organization_id, account.address);
    }

    return {};
  }
}

/**
 * A comment on one of the account's posts, or a reply under one, lands in its
 * author's conversation (where their DMs land too) with the post it is on.
 * The account's own replies from the TikTok app land in the conversation of
 * the comment they sit under; the ones sent from here are rows already, and
 * its own top-level comments sit under nobody's. A deleted comment is marked
 * deleted; a change of visibility changes nothing here.
 */
async function persistComment(client: Client, payload: TikTokWebhookPayload) {
  const event = readContent<TikTokCommentEvent>(payload);
  const { comment_id, video_id, comment_action } = event;

  if (comment_action !== "insert" && comment_action !== "delete") {
    log.info("Unhandled TikTok comment action", { comment_action, comment_id });
    return;
  }

  if (!comment_id || !video_id) {
    log.warn("TikTok comment webhook without a comment or a post", {
      comment_action,
    });
    return;
  }

  const account = await findAccount(client, payload);
  if (!account) return;

  const ms = event.timestamp ??
    (payload.create_time ? payload.create_time * 1000 : Date.now());
  const timestamp = new Date(ms).toISOString();

  // Delivered again, or one sent from here coming back.
  const { data: known } = await client
    .from("messages")
    .select("id")
    .eq("organization_id", account.organization_id)
    .eq("external_id", comment_id)
    .maybeSingle()
    .throwOnError();

  if (comment_action === "delete") {
    if (known) {
      await client
        .from("messages")
        .update({ status: { deleted: timestamp } })
        .eq("id", known.id)
        .throwOnError();
    }
    return;
  }

  if (known) return;

  const { comment, video } = await readComment(
    client,
    account,
    comment_id,
    video_id,
  );

  const thumbnail = await storePostThumbnail(
    client,
    account.organization_id,
    "tiktok",
    video_id,
    video?.thumbnail_url,
  );

  // A top-level comment says "0" for its parent.
  const parent_id = [event.parent_comment_id, comment?.parent_comment_id]
    .find((id) => id && id !== "0");

  const content = {
    version: "1",
    type: "data",
    kind: "comment",
    data: {
      post: {
        type: "tiktok_post",
        item_id: video_id,
        ...(video?.share_url && { url: video.share_url }),
        ...(video?.caption && { title: video.caption }),
        ...(thumbnail && { thumbnail }),
      },
    },
    text: comment?.text ?? event.text ?? "",
    ...(parent_id && { re_message_id: parent_id }),
  } satisfies CommentPart & { version: "1"; re_message_id?: string };

  const addressing = {
    organization_id: account.organization_id,
    service: "tiktok" as const,
    organization_address: account.address,
  };

  if (comment?.owner) {
    const { data: parent } = parent_id
      ? await client
        .from("messages")
        .select("conversation_address")
        .eq("organization_id", account.organization_id)
        .eq("external_id", parent_id)
        .maybeSingle()
        .throwOnError()
      : { data: null };

    if (!parent) {
      log.info("Own TikTok comment under no known comment, skipped", {
        comment_id,
      });
      return;
    }

    await client
      .from("messages")
      .upsert({
        ...addressing,
        conversation_address: parent.conversation_address,
        external_id: comment_id,
        content,
        status: { sent: timestamp },
        timestamp,
      }, { onConflict: "external_id" })
      .throwOnError();

    return;
  }

  const author = event.unique_identifier || comment?.unique_identifier;

  if (!author) {
    log.warn("TikTok comment without an author", { comment_id });
    return;
  }

  const extra: TikTokContactAddressExtra = {
    ...(comment?.username && { username: comment.username }),
    ...(comment?.display_name && { name: comment.display_name }),
    ...(comment?.profile_image && {
      profile_picture_url: comment.profile_image,
    }),
  };

  // merge_update keeps the keys the DMs wrote.
  if (Object.keys(extra).length) {
    await client
      .from("contacts_addresses")
      .upsert({ ...addressing, address: author, extra })
      .throwOnError();
  }

  await client
    .from("messages")
    .upsert({
      ...addressing,
      conversation_address: author,
      sender_address: author,
      external_id: comment_id,
      content,
      timestamp,
    }, { onConflict: "external_id" })
    .throwOnError();

  log.info("TikTok comment persisted", {
    organization_id: account.organization_id,
    comment_id,
    reply: !!parent_id,
  });
}
