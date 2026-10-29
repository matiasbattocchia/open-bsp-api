// Outgoing Slack dispatch. Triggered by dispatcher_edge_function() when a
// message row lands with sender_address null (the account spoke), not
// record-only (content.internal), and status.pending.
//
// The wire identity is the MEMBER when the row names an agent with a personal
// connection: their xoxp user token (address row T…:U…) is what talks to
// Slack, and chat.postMessage with a user token posts genuinely as them.
// Otherwise it is the workspace BOT, whose token lives on the ownerless
// anchor — the bot is the shared inbox, so rows without a member (API keys,
// automations, AI agents) go out as the app instead of failing.
//
// external_id is stamped as `${team}:${channel}:${ts}` — the same format the
// webhook uses — so the echo Slack sends back merges into this row (or, if
// the echo lands first, commitDispatchedMessage folds the duplicate).
import * as log from "../_shared/logger.ts";
import {
  createUnsecureClient,
  type MessageRow,
  type OutgoingMessage,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "../_shared/db_types.ts";
import { commitDispatchedMessage } from "../_shared/dispatch.ts";
import { downloadFromStorage } from "../_shared/media.ts";
import { markdownToSlack } from "../_shared/markdown.ts";
import {
  DEAD_TOKEN_ERRORS,
  disconnectConnection,
  ensureFreshToken,
  slackApi,
  type SlackConnection,
  SlackError,
} from "../_shared/slack.ts";
import { shortcodeFromEmoji } from "../_shared/emoji.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Transient Slack errors worth retrying (the retry cron re-fires pending
 * messages when we respond 500). HTTP 429 is already retried inside slackApi;
 * `ratelimited` covers the give-up case.
 */
const RETRYABLE_SLACK_ERRORS = new Set([
  "ratelimited",
  "internal_error",
  "service_unavailable",
]);

class PermanentError extends Error {}

/**
 * Which identity posts this message. A member's personal connection when the
 * row names an agent that has one — chat.postMessage with an xoxp token posts
 * genuinely as that person. Otherwise the workspace bot, whose token lives on
 * the ownerless anchor: the bot is the shared inbox, so a row with no agent
 * (an API key, an automation, an AI agent) goes out as the app rather than
 * failing. Falling back is deliberate — "no member" is not an error when a
 * shared-inbox connection exists.
 */
async function getConnection(
  client: SupabaseClient,
  message: MessageRow,
): Promise<{ connection: SlackConnection; asBot: boolean }> {
  if (message.agent_id) {
    const { data } = await client
      .from("organizations_addresses")
      .select("address, status, extra")
      .eq("organization_id", message.organization_id)
      .eq("service", "slack")
      .eq("agent_id", message.agent_id)
      .like("address", `${message.organization_address}:%`)
      .maybeSingle()
      .throwOnError();

    if (data && data.status === "connected" && data.extra?.access_token) {
      return { connection: data as SlackConnection, asBot: false };
    }
  }

  // The anchor row (address = team id, ownerless). It only carries an
  // access_token once a bot install granted one.
  const { data: anchor } = await client
    .from("organizations_addresses")
    .select("address, status, extra")
    .eq("organization_id", message.organization_id)
    .eq("service", "slack")
    .eq("address", message.organization_address!)
    .maybeSingle()
    .throwOnError();

  if (anchor && anchor.status === "connected" && anchor.extra?.access_token) {
    return { connection: anchor as SlackConnection, asBot: true };
  }

  throw new PermanentError(
    message.agent_id
      ? `Agent ${message.agent_id} has no connected Slack account for workspace ${message.organization_address}, and no bot is installed`
      : `Message has no agent_id and no bot is installed for workspace ${message.organization_address}`,
  );
}

/**
 * Re-encodes user mentions for the wire: each content.mentions entry whose
 * `@Name` appears in the text becomes `<@U…>`. The Slack user id is the
 * mention's `address`, or — for a member named only by `agent_id` — the user
 * segment of their personal connection (T…:U…). Unresolvable mentions stay
 * plain @Name, which Slack renders as text.
 */
async function encodeMentions(
  client: SupabaseClient,
  message: MessageRow,
  text: string,
): Promise<string> {
  const mentions = (message.content as OutgoingMessage).mentions ?? [];
  if (mentions.length === 0) return text;

  const resolved: Array<{ name: string; user: string }> = [];

  for (const mention of mentions) {
    if (!mention.name) continue;

    let user = mention.address;

    if (!user && mention.agent_id) {
      const { data } = await client
        .from("organizations_addresses")
        .select("address")
        .eq("organization_id", message.organization_id)
        .eq("service", "slack")
        .eq("agent_id", mention.agent_id)
        .like("address", `${message.organization_address}:%`)
        .maybeSingle()
        .throwOnError();

      user = data?.address?.split(":")[1];
    }

    if (user) resolved.push({ name: mention.name, user });
  }

  // Longest name first, so "@Ana María" is not half-claimed by "@Ana".
  resolved.sort((a, b) => b.name.length - a.name.length);

  for (const { name, user } of resolved) {
    text = text.replaceAll(`@${name}`, `<@${user}>`);
  }

  return text;
}

/**
 * Sends the message; returns the Slack ts of the posted message when there is
 * one to track (text posts). Reactions and file uploads yield none — their
 * echoes arrive as webhook rows instead.
 */
async function send(
  client: SupabaseClient,
  token: string,
  message: MessageRow,
): Promise<string | undefined> {
  const content = message.content as OutgoingMessage;
  const channel = message.conversation_address!;

  switch (content.kind) {
    case "text": {
      const payload = await slackApi("chat.postMessage", token, {
        channel,
        text: await encodeMentions(
          client,
          message,
          markdownToSlack(content.text),
        ),
        ...(message.thread_id ? { thread_ts: message.thread_id } : {}),
      });

      return payload.ts as string;
    }

    case "reaction": {
      if (!content.re_message_id) {
        throw new PermanentError(
          "Cannot send a Slack reaction without re_message_id",
        );
      }

      // Reactions are data-only: {action, name, unicode}. The wire name
      // resolves from data.name, else from data.unicode mapped back through
      // the shortcode table.
      const data = (content as {
        data?: {
          action?: "added" | "removed";
          name?: string;
          unicode?: string;
        };
      }).data;

      if (!data?.action) {
        throw new PermanentError("Slack reactions require data.action");
      }

      const name = data.name ??
        (data.unicode ? shortcodeFromEmoji(data.unicode) : undefined);
      const action = data.action;

      if (!name) {
        throw new PermanentError(
          "Slack reactions need the emoji name (data.name or data.unicode)",
        );
      }

      // external ids are `${team}:${channel}:${ts}`; the reactions API wants
      // the bare ts.
      const timestamp = content.re_message_id.split(":").pop()!;

      await slackApi(
        action === "added" ? "reactions.add" : "reactions.remove",
        token,
        { channel, timestamp, name },
      );

      return undefined;
    }

    case "audio":
    case "image":
    case "video":
    case "document":
    case "file":
    case "media": {
      const blob = await downloadFromStorage(client, content.file.uri);
      const filename = content.file.name ?? "file";

      const upload = await slackApi("files.getUploadURLExternal", token, {
        filename,
        length: String(blob.size),
      });

      const uploadResponse = await fetch(upload.upload_url as string, {
        method: "POST",
        body: blob,
      });

      if (!uploadResponse.ok) {
        throw new SlackError(
          `Slack file upload failed (${uploadResponse.status})`,
          { cause: await uploadResponse.text() },
        );
      }

      // Upload-then-reference, the same shape as WhatsApp's media flow:
      // complete the upload WITHOUT a channel (sharing via
      // files.completeUploadExternal's channel_id posts asynchronously and
      // returns no ts), then post a regular message whose <permalink| >
      // reference shares and unfurls the file. chat.postMessage returns the
      // ts synchronously, so the echo merges into this row like any text
      // send.
      const completed = await slackApi("files.completeUploadExternal", token, {
        files: JSON.stringify([{ id: upload.file_id, title: filename }]),
      });

      const permalink = (completed.files as Array<{ permalink?: string }>)?.[0]
        ?.permalink;

      if (!permalink) {
        throw new SlackError("completeUploadExternal returned no permalink", {
          cause: completed,
        });
      }

      const caption = content.text
        ? `${await encodeMentions(
          client,
          message,
          markdownToSlack(content.text),
        )}\n`
        : "";

      const payload = await slackApi("chat.postMessage", token, {
        channel,
        text: `${caption}<${permalink}| >`,
        ...(message.thread_id ? { thread_ts: message.thread_id } : {}),
      });

      return payload.ts as string;
    }

    default:
      throw new PermanentError(
        `Cannot send content of type ${content.type} and kind ${content.kind} to Slack`,
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

  // Read receipts / typing indicators have no Slack Web API for user tokens —
  // the mark-as-read trigger also excludes Slack by name, so this is belt
  // and suspenders.
  if (message.sender_address !== null) {
    return new Response();
  }

  let used: SlackConnection | undefined;

  try {
    const { connection, asBot } = await getConnection(client, message);
    used = connection;
    const accessToken = await ensureFreshToken(
      client,
      message.organization_id,
      connection,
    );

    log.info("Slack dispatch", {
      message_id: message.id,
      as: asBot ? "bot" : "member",
      address: connection.address,
    });

    const ts = await send(client, accessToken, message);

    await commitDispatchedMessage({
      client,
      messageId: message.id,
      externalId: ts
        ? `${message.organization_address}:${message.conversation_address}:${ts}`
        : undefined,
      status: { accepted: new Date().toISOString() },
    });
  } catch (error) {
    const slackCode = error instanceof SlackError
      ? (error.cause as { error?: string } | undefined)?.error
      : undefined;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorDetail: Json = error instanceof SlackError
      ? (error.cause as Json)
      : errorMessage;

    if (slackCode && DEAD_TOKEN_ERRORS.has(slackCode)) {
      // Dead token: fail the message and flip the connection so the UI
      // prompts a reconnect (same semantics as tokens_revoked). A dead
      // REFRESH token was already disconnected inside ensureFreshToken;
      // this update is then a no-op.
      log.error("Dispatch failed (token error)", {
        message_id: message.id,
        code: slackCode,
      });

      // Disconnect the row whose token actually failed, by address. Keying
      // on agent_id would miss the bot: its connection is the ownerless
      // anchor, so agent_id is null and there is no `T…:U…` address either.
      // `used` is unset only if getConnection itself threw, which is not a
      // token error.
      if (used) {
        await disconnectConnection(
          client,
          message.organization_id,
          used.address,
        );
      }
    }

    const isRetryable = slackCode
      ? RETRYABLE_SLACK_ERRORS.has(slackCode)
      : !(error instanceof PermanentError) && !slackCode;

    if (isRetryable && !(slackCode && DEAD_TOKEN_ERRORS.has(slackCode))) {
      // Transient: surface the error but keep status.pending so the retry
      // cron re-fires; rethrow so this invocation returns 500.
      log.warn("Dispatch failed (transient, will retry)", {
        message_id: message.id,
        code: slackCode,
        error: errorMessage,
      });

      await client
        .from("messages")
        .update({ status: { errors: [errorDetail] } })
        .eq("id", message.id)
        .throwOnError();

      throw error;
    }

    log.error("Dispatch failed (permanent)", {
      message_id: message.id,
      code: slackCode,
      error: errorMessage,
    });

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
});
