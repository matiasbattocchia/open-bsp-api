// Slack event handlers. All writes are idempotent (external_id upserts, PK
// upserts) so Slack's up-to-3 retries need no dedup store.
//
// Mapping rules (see slack-management/index.ts header for the address model):
//   - conversation address = channel id (D…/G…/C…), anchored to the team.
//   - sender_address = the Slack user id (a contact reference); agent_id set
//     when the sender is a linked member. Mirrored rows are armed like any
//     other inbound message ({pending, sent}); what keeps the AI out of a
//     workspace is the team-chat rule in agent-client, not the status.
//   - Sends made through OpenBSP come back as message events too; the
//     external_id upsert merges them into the dispatcher's row and FILLS its
//     sender_address (null → the member who sent — fill-once in
//     preserve_message_addressing). When the echo lands first,
//     commitDispatchedMessage folds the duplicate.
import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "../_shared/logger.ts";
import type {
  IncomingMessage,
  IncomingStatus,
  Mention,
  MessageInsert,
} from "../_shared/supabase.ts";
import { MAX_STORAGE_UPLOAD_SIZE, uploadToStorage } from "../_shared/media.ts";
import {
  ensureFreshToken,
  eventAuthorizations,
  slackApi,
  type SlackConnection,
  type SlackUser,
  usersInfo,
} from "../_shared/slack.ts";
import { slackToMarkdown } from "../_shared/markdown.ts";
import { emojiFromShortcode } from "../_shared/emoji.ts";

import type {
  ChannelArchiveEvent,
  ChannelRenameEvent,
  ChannelUnarchiveEvent,
  MemberJoinedChannelEvent,
  MemberLeftChannelEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
  TokensRevokedEvent,
  UserChangeEvent,
} from "@slack/types";
import {
  type ChannelShape,
  channelTypeFromChannel,
  channelTypeFromMessageEvent,
  type SlackEnvelope,
  type SlackFile,
  type SlackMessageEvent,
} from "../_shared/slack_events.ts";

export type { SlackEnvelope };

const tsToIso = (ts: string) => new Date(parseFloat(ts) * 1000).toISOString();

const externalId = (team: string, channel: string, ts: string) =>
  `${team}:${channel}:${ts}`;

export async function handleEvent(
  client: SupabaseClient,
  organization_id: string,
  envelope: SlackEnvelope,
  bot_user_id: string | null = null,
): Promise<void> {
  const team = envelope.team_id!;
  const event = envelope.event;
  if (!event) return;

  const ctx: Ctx = { client, organization_id, team, envelope, bot_user_id };

  switch (event.type) {
    case "message":
      return await onMessage(ctx, event);
    case "reaction_added":
    case "reaction_removed":
      return await onReaction(ctx, event);
    case "member_joined_channel":
      return await onMemberJoined(ctx, event);
    case "member_left_channel":
      return await onMemberLeft(ctx, event);
    case "channel_rename":
      return await onChannelRename(ctx, event);
    case "channel_archive":
    case "channel_unarchive":
      return await onChannelArchive(ctx, event);
    case "user_change":
      return await onUserChange(ctx, event);
    case "tokens_revoked":
      return await onTokensRevoked(ctx, event);
    case "app_uninstalled":
      return await onAppUninstalled(ctx);
    default:
      // Unsubscribed type: the union above is exhaustive, so `event` is
      // `never` here. The one cast in this file, and the only place the
      // payload is not fully described by an official type.
      log.info(
        `Ignoring Slack event type ${(event as { type: string }).type}`,
      );
  }
}

type Ctx = {
  client: SupabaseClient;
  organization_id: string;
  team: string;
  envelope: SlackEnvelope;
  /** The workspace bot's Slack user id, or null if no bot is installed. */
  bot_user_id: string | null;
};

/** Personal address row of a linked member, or null. */
async function linkedAgent(
  ctx: Ctx,
  slackUser: string,
): Promise<{ agent_id: string; address: string } | null> {
  const address = `${ctx.team}:${slackUser}`;

  const { data } = await ctx.client
    .from("organizations_addresses")
    .select("agent_id")
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .eq("address", address)
    .not("agent_id", "is", null)
    .maybeSingle()
    .throwOnError();

  return data?.agent_id ? { agent_id: data.agent_id, address } : null;
}

/** Any usable token for this workspace — for reads that need one (users.info,
 * conversations.info, file downloads); Slack scopes them per-identity but
 * directory and shared-file reads are equivalent across them.
 *
 * Candidates are every connected member PLUS the anchor, which carries the
 * bot token when a bot is installed. The anchor matters on its own: an org
 * may install ONLY the bot and never connect a member, and without it every
 * read here would have no token at all.
 *
 * Expiry-aware: each candidate goes through ensureFreshToken (refreshing
 * rotated tokens about to expire), falling back to the next when one fails. */
async function anyWorkspaceToken(ctx: Ctx): Promise<string | null> {
  const { data } = await ctx.client
    .from("organizations_addresses")
    .select("address, extra")
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .eq("status", "connected")
    .or(`address.eq.${ctx.team},address.like.${ctx.team}:%`)
    .not("extra->>access_token", "is", null)
    .throwOnError();

  for (const connection of (data ?? []) as SlackConnection[]) {
    try {
      return await ensureFreshToken(
        ctx.client,
        ctx.organization_id,
        connection,
      );
    } catch (error) {
      // Dead refresh tokens already disconnected the row inside
      // ensureFreshToken; either way try the next connected member.
      log.warn(
        `Workspace token unusable for ${connection.address}, trying next`,
        error,
      );
    }
  }

  return null;
}

/**
 * Records ingestor-owned facts on a conversation.
 *
 * `extra` is safe for these even though it is a public bag, because RLS grants
 * no API role UPDATE on conversations for any service but `local` — the
 * policy is what keeps members out, so the facts visibility depends on can sit
 * beside cosmetic ones. Edge functions use the service role, which the policy
 * does not apply to.
 *
 * Omitting `is_bot_member` leaves whatever is stored; absent means false, and
 * false means not shared with the org. Set it true only where the bot is
 * actually present — its membership is what makes a Slack container org-wide,
 * since the anchor these all hang off is ownerless.
 */
async function setChannelFacts(
  ctx: Ctx,
  conversation_id: string,
  facts: { is_bot_member?: boolean; channel_archived?: boolean },
): Promise<void> {
  // `extra` is deep-merged by the set_extra trigger, so this patches the named
  // keys and leaves the rest.
  await ctx.client
    .from("conversations")
    .update({ extra: facts })
    .eq("id", conversation_id)
    .throwOnError();
}

/** The channel's shape: `type` in its own column, arity in extra (merged by
 * the set_extra trigger, and only ever written true — absent means 1:1). */
async function setConversationType(
  ctx: Ctx,
  conversation_id: string,
  shape: ChannelShape,
): Promise<void> {
  await ctx.client
    .from("conversations")
    .update({
      type: shape.type,
      ...(shape.is_multiple && { extra: { is_multiple: true } }),
    })
    .eq("id", conversation_id)
    .throwOnError();
}

/** Whether the workspace bot is one of the installs this event applies to. */
function botIsAuthorized(
  ctx: Ctx,
  authorizations: Array<{ user_id: string; is_bot?: boolean }>,
): boolean {
  if (!ctx.bot_user_id) return false;

  return authorizations.some((a) =>
    a.is_bot === true || a.user_id === ctx.bot_user_id
  );
}

/**
 * Finds the conversation for a channel; creates it (plus its audience) on
 * first contact — e.g. a DM opened after the members' initial sync. The
 * audience comes from apps.event.authorizations.list (all installs this
 * event applies to), falling back to the envelope's partial list.
 */
async function ensureConversation(
  ctx: Ctx,
  channel: string,
  channel_type?: ChannelShape,
): Promise<string> {
  const { data: existing } = await ctx.client
    .from("conversations")
    .select("id, type")
    .eq("organization_id", ctx.organization_id)
    .eq("organization_address", ctx.team)
    .eq("address", channel)
    .eq("service", "slack")
    .maybeSingle()
    .throwOnError();

  if (existing) {
    // Backfill a classification the creating event could not supply (a
    // reaction or a member_joined arriving before any message). Without this
    // the gap is sticky: `type` stays null forever, because every later event
    // short-circuits on the existing row. This is the reason the column has no
    // default for slack — a default would make "unknown" indistinguishable
    // from "direct" and the row would never self-heal.
    if (!existing.type) {
      const resolved = channel_type ?? await resolveChannelType(ctx, channel);

      if (resolved) await setConversationType(ctx, existing.id, resolved);
    }

    return existing.id;
  }

  const resolved = channel_type ?? await resolveChannelType(ctx, channel);

  // Needed before the insert: is_bot_member is decided by whether the bot is
  // one of the installs this event reached, which is what a bot-reachable
  // container looks like on first contact.
  const authorizations =
    (await eventAuthorizations(ctx.envelope.event_context ?? "")) ??
      ctx.envelope.authorizations ?? [];

  const { data: created } = await ctx.client
    .from("conversations")
    .insert({
      organization_id: ctx.organization_id,
      service: "slack" as const,
      organization_address: ctx.team,
      address: channel,
      type: resolved?.type,
      // Always written, including false: absent means not shared, and every
      // Slack conversation hangs off the ownerless anchor, so leaving it out
      // would be trusting a default we do not want to depend on.
      extra: {
        is_bot_member: botIsAuthorized(ctx, authorizations),
        ...(resolved?.is_multiple && { is_multiple: true }),
      },
    })
    .select("id")
    .single()
    .throwOnError();

  for (const auth of authorizations) {
    if (auth.is_bot || !auth.user_id) continue;

    const linked = await linkedAgent(ctx, auth.user_id);
    if (!linked) continue;

    await ctx.client
      .from("conversations_agents")
      .upsert({
        organization_id: ctx.organization_id,
        service: "slack",
        organization_address: linked.address,
        conversation_id: created.id,
        agent_id: linked.agent_id,
      }, { onConflict: "conversation_id,agent_id" })
      .throwOnError();
  }

  return created.id;
}

/**
 * Authoritative classification via conversations.info — the only source that
 * always separates public from private. Used when the event's own
 * channel_type is absent (reactions) or inconclusive (member_joined reports
 * `C`, which covers public channels AND private ones created after March
 * 2021). Returns undefined if no workspace token is usable; the caller then
 * records no channel_type rather than guessing.
 */
async function resolveChannelType(
  ctx: Ctx,
  channel: string,
): Promise<ChannelShape | undefined> {
  const token = await anyWorkspaceToken(ctx);
  if (!token) return undefined;

  try {
    const info = await slackApi("conversations.info", token, { channel });
    return info.channel ? channelTypeFromChannel(info.channel) : undefined;
  } catch (error) {
    log.warn(`Slack conversations.info failed for ${channel}`, error);
    return undefined;
  }
}

/** Makes sure an unlinked sender exists in the directory (joined after the
 * members' sync); fetches the profile lazily with any workspace token.
 * Apps (bot_id senders) are not workspace users, so users.info cannot name
 * them — the caller passes the name off the message payload instead. */
async function ensureContact(
  ctx: Ctx,
  slackUser: string,
  opts: { name?: string; isApp?: boolean } = {},
): Promise<void> {
  const { data } = await ctx.client
    .from("contacts_addresses")
    .select("address")
    .eq("organization_id", ctx.organization_id)
    .eq("organization_address", ctx.team)
    .eq("service", "slack")
    .eq("address", slackUser)
    .maybeSingle()
    .throwOnError();

  if (data) return;

  const token = opts.isApp ? null : await anyWorkspaceToken(ctx);
  const profile: SlackUser | null = token
    ? await usersInfo(token, slackUser)
    : null;

  await ctx.client
    .from("contacts_addresses")
    .upsert({
      organization_id: ctx.organization_id,
      organization_address: ctx.team,
      service: "slack" as const,
      address: slackUser,
      extra: {
        synced: {
          action: "add",
          name: profile?.profile?.display_name ||
            profile?.profile?.real_name || profile?.name || opts.name ||
            slackUser,
        },
        team_id: ctx.team,
        is_app: opts.isApp || undefined,
        picture: profile?.profile?.image_192,
      },
    }, { onConflict: "organization_id,organization_address,service,address" })
    .throwOnError();
}

const SLACK_MENTION_RE = /<@([A-Z0-9]+)(?:\|([^>]+))?>/g;

/**
 * Resolves `<@U…>` user mentions: each token becomes `@Name` in the stored
 * markdown, and the mentioned users land in `content.mentions` — `address`
 * in contact space (the Slack user id), `agent_id` when they are a linked
 * member. Names come from the token's own label, the directory
 * (contacts_addresses), the agents roster, or users.info, in that order; an
 * id nothing can name keeps its token verbatim rather than losing it.
 */
async function resolveMentions(
  ctx: Ctx,
  raw: string,
): Promise<{ text: string; mentions?: Mention[] }> {
  const tokens = [...raw.matchAll(SLACK_MENTION_RE)];
  if (tokens.length === 0) return { text: slackToMarkdown(raw) };

  const ids = [...new Set(tokens.map((t) => t[1]))];

  const { data: contacts } = await ctx.client
    .from("contacts_addresses")
    .select("address, extra")
    .eq("organization_id", ctx.organization_id)
    .eq("organization_address", ctx.team)
    .eq("service", "slack")
    .in("address", ids)
    .throwOnError();

  const contactName = new Map<string, string | undefined>(
    (contacts ?? []).map((
      c: { address: string; extra?: { synced?: { name?: string } } },
    ) => [c.address, c.extra?.synced?.name]),
  );

  const { data: linked } = await ctx.client
    .from("organizations_addresses")
    .select("address, agent_id")
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .in("address", ids.map((id) => `${ctx.team}:${id}`))
    .not("agent_id", "is", null)
    .throwOnError();

  const memberByUser = new Map<string, string>(
    (linked ?? []).map((
      l: { address: string; agent_id: string },
    ) => [l.address.split(":")[1], l.agent_id]),
  );

  const agentName = new Map<string, string>();
  if (memberByUser.size > 0) {
    const { data: agents } = await ctx.client
      .from("agents")
      .select("id, name")
      .in("id", [...memberByUser.values()])
      .throwOnError();

    for (const a of (agents ?? []) as Array<{ id: string; name: string }>) {
      agentName.set(a.id, a.name);
    }
  }

  const mentions: Mention[] = [];
  for (const id of ids) {
    const agent_id = memberByUser.get(id);
    const label = tokens.find((t) => t[1] === id)?.[2];
    let name = label ?? contactName.get(id) ??
      (agent_id ? agentName.get(agent_id) : undefined);

    if (!name) {
      const token = await anyWorkspaceToken(ctx);
      const profile = token ? await usersInfo(token, id) : null;
      name = profile?.profile?.display_name || profile?.profile?.real_name ||
        profile?.name || undefined;
    }

    mentions.push({
      address: id,
      ...(agent_id ? { agent_id } : {}),
      ...(name ? { name } : {}),
    });
  }

  const named = new Map(mentions.map((m) => [m.address, m.name]));
  const text = raw.replace(
    SLACK_MENTION_RE,
    (token, id: string) => named.get(id) ? `@${named.get(id)}` : token,
  );

  return { text: slackToMarkdown(text), mentions };
}

// Regular messages, file shares, thread broadcasts, edits and deletions.
async function onMessage(
  ctx: Ctx,
  event: SlackMessageEvent,
): Promise<void> {
  const channel = event.channel as string;

  if (event.subtype === "message_changed") {
    if (!event.message?.ts) return;

    const { text, mentions } = await resolveMentions(
      ctx,
      event.message.text ?? "",
    );

    await ctx.client
      .from("messages")
      .update({
        // `mentions: null` on a mention-less edit: the content merge is
        // merge-patch, where null removes the key — otherwise mentions from
        // the pre-edit text would survive it.
        content: { text, mentions: mentions ?? null },
        status: { edited: tsToIso(event.event_ts ?? event.message.ts) },
      })
      .eq("external_id", externalId(ctx.team, channel, event.message.ts))
      .throwOnError();
    return;
  }

  if (event.subtype === "message_deleted") {
    if (!event.deleted_ts) return;

    await ctx.client
      .from("messages")
      .update({
        status: { deleted: tsToIso(event.event_ts ?? event.deleted_ts) },
      })
      .eq("external_id", externalId(ctx.team, channel, event.deleted_ts))
      .throwOnError();
    return;
  }

  // Plain messages, file shares, thread broadcasts and app-authored posts.
  // System subtypes (channel_join, channel_topic, …) are not mirrored.
  if (
    (event.subtype &&
      !["file_share", "thread_broadcast", "bot_message"].includes(
        event.subtype,
      )) || !event.ts
  ) {
    return;
  }

  // An app-authored message identifies its author with bot_id; `user` is only
  // sometimes present (required on a generic message, optional on a
  // bot_message). Fall back so third-party apps — CI, alerts, GitHub — are
  // mirrored rather than dropped, which matters now that the bot sits in the
  // channels those post to.
  const sender = event.user ?? event.bot_id;
  if (!sender) return;

  // Our OWN bot's posts are the echo of a dispatch that already stamped
  // external_id from the ts chat.postMessage returned. Re-ingesting would
  // fill sender_address with the bot's id, but a bot-sent row means "the
  // account spoke" and must keep sender null. Matched by user id, so only
  // THIS workspace's bot is skipped — every other app comes through.
  //
  // Unverified against a live workspace: this assumes our own posts arrive
  // with `user` set (true for a plain chat.postMessage with a bot token;
  // a bot_message with username/icon overrides carries no `user`, and we
  // send none). If one ever slips past, the damage is bounded — the
  // external_id upsert merges it into the dispatched row rather than
  // duplicating, and only sender_address is wrong.
  if (ctx.bot_user_id && event.user === ctx.bot_user_id) return;

  const conversation_id = await ensureConversation(
    ctx,
    channel,
    channelTypeFromMessageEvent(event.channel_type),
  );

  const linked = await linkedAgent(ctx, sender);
  if (!linked) {
    await ensureContact(ctx, sender, {
      // Apps are not in the workspace directory, so users.info cannot name
      // them; the payload carries the display name instead.
      name: event.bot_id
        ? (event.username ?? event.bot_profile?.name)
        : undefined,
      isApp: Boolean(event.bot_id),
    });
  }

  const base = {
    organization_id: ctx.organization_id,
    conversation_id,
    service: "slack" as const,
    organization_address: ctx.team,
    conversation_address: channel,
    sender_address: sender,
    agent_id: linked?.agent_id,
    thread_id: event.thread_ts,
    timestamp: tsToIso(event.ts),
    // Same shape as every other inbound message, and one shape for two cases.
    //
    // `pending` is what arms the platform: the media preprocessor on file
    // messages, and the mark-as-read path. The AI is kept out by a rule
    // (team chat), not by what this webhook happens to write.
    //
    // `sent` is the receipt. On a colleague's message it says when Slack
    // stamped it; on the echo of a member send it lands on the row the
    // dispatcher already stamped `accepted` — the upsert conflicts on
    // external_id and merges — which is the closest thing to a delivery
    // confirmation Slack offers.
    status: {
      pending: new Date().toISOString(),
      sent: tsToIso(event.event_ts ?? event.ts),
    } as IncomingStatus,
  };

  const rows: MessageInsert[] = [];

  const files = event.files ?? [];

  const { text, mentions } = await resolveMentions(ctx, event.text ?? "");

  if (files.length === 0) {
    rows.push({
      ...base,
      external_id: externalId(ctx.team, channel, event.ts),
      content: {
        version: "1",
        type: "text",
        kind: "text",
        text,
        ...(mentions ? { mentions } : {}),
      } as IncomingMessage,
    });
  } else {
    const token = await anyWorkspaceToken(ctx);

    for (const [index, file] of files.entries()) {
      const uri = await downloadFile(ctx, token, file);
      // One row per file; Slack's message text is the caption of the first
      // (mentions ride with it).
      const caption = index === 0 && event.text
        ? { text, ...(mentions ? { mentions } : {}) }
        : {};

      rows.push({
        ...base,
        external_id: index === 0
          ? externalId(ctx.team, channel, event.ts)
          : `${externalId(ctx.team, channel, event.ts)}:f${index}`,
        content: uri
          ? {
            version: "1",
            type: "file",
            kind: kindFromMime(file.mimetype ?? ""),
            file: {
              mime_type: file.mimetype ?? "application/octet-stream",
              uri,
              name: file.name,
              size: file.size ?? 0,
            },
            ...caption,
          } as IncomingMessage
          // Download failed/oversized/no token: keep the message with a
          // placeholder so the timeline stays complete. Slack still told us
          // what the file was, so that much travels with it.
          : {
            version: "1",
            type: "data",
            kind: "media_placeholder",
            data: {},
            file: {
              mime_type: file.mimetype ?? "application/octet-stream",
              name: file.name,
              size: file.size ?? 0,
            },
            ...caption,
          } as IncomingMessage,
      });
    }
  }

  await ctx.client
    .from("messages")
    .upsert(rows, { onConflict: "external_id" })
    .throwOnError();
}

async function downloadFile(
  ctx: Ctx,
  token: string | null,
  file: SlackFile,
): Promise<string | null> {
  if (!token || !file.url_private) return null;

  if ((file.size ?? 0) > MAX_STORAGE_UPLOAD_SIZE) {
    log.warn(`Slack file ${file.id} exceeds storage limit, skipping`);
    return null;
  }

  try {
    const response = await fetch(file.url_private, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      log.warn(`Slack file download failed (${response.status})`, file.id);
      return null;
    }

    const blob = await response.blob();
    return await uploadToStorage(
      ctx.client,
      ctx.organization_id,
      blob,
      file.name,
    );
  } catch (error) {
    log.warn(`Slack file download failed`, { file: file.id, error });
    return null;
  }
}

function kindFromMime(mime: string): "image" | "audio" | "video" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

// Reactions are data parts (multi-user, add/remove) referencing the reacted
// message via re_message_id — see ReactionPart in message_types.ts.
async function onReaction(
  ctx: Ctx,
  event: ReactionAddedEvent | ReactionRemovedEvent,
): Promise<void> {
  if (event.item?.type !== "message") return;
  const { channel, ts } = event.item;
  if (!channel || !ts || !event.user || !event.reaction) return;

  // Our own bot's reaction is the echo of a dispatch. Unlike a message it
  // carries no ts to stamp an external_id from, so re-ingesting it would add
  // a duplicate row attributed to the bot — which is not a directory contact.
  // Matched by user id, so other apps' reactions still come through.
  if (ctx.bot_user_id && event.user === ctx.bot_user_id) return;

  const conversation_id = await ensureConversation(ctx, channel);
  const linked = await linkedAgent(ctx, event.user);

  await ctx.client
    .from("messages")
    .upsert({
      organization_id: ctx.organization_id,
      conversation_id,
      service: "slack" as const,
      organization_address: ctx.team,
      conversation_address: channel,
      sender_address: event.user,
      agent_id: linked?.agent_id,
      external_id: externalId(ctx.team, channel, event.event_ts ?? ts),
      timestamp: tsToIso(event.event_ts ?? ts),
      // Same shape as an inbound message — see the comment there.
      status: {
        pending: new Date().toISOString(),
        sent: tsToIso(event.event_ts ?? ts),
      } as IncomingStatus,
      content: {
        version: "1",
        type: "data",
        kind: "reaction",
        // Data-only (rendering is the UI's job): {action, name, unicode};
        // unicode absent for custom workspace emoji.
        data: {
          action: event.type === "reaction_added" ? "added" : "removed",
          name: event.reaction,
          unicode: emojiFromShortcode(event.reaction),
        },
        re_message_id: externalId(ctx.team, channel, ts),
      } as IncomingMessage,
    }, { onConflict: "external_id" })
    .throwOnError();
}

async function onMemberJoined(
  ctx: Ctx,
  event: MemberJoinedChannelEvent,
): Promise<void> {
  const channel = event.channel;
  if (!event.user || !channel) return;

  // The bot joining is a visibility event, not a membership one: it makes the
  // container reachable org-wide. It gets no conversations_agents row — that
  // table maps conversations to MEMBERS, and the bot is nobody's agent.
  if (event.user === ctx.bot_user_id) {
    const conversation_id = await ensureConversation(ctx, channel);

    await setChannelFacts(ctx, conversation_id, { is_bot_member: true });

    return;
  }

  const linked = await linkedAgent(ctx, event.user);
  if (!linked) return;

  const conversation_id = await ensureConversation(ctx, channel);

  await ctx.client
    .from("conversations_agents")
    .upsert({
      organization_id: ctx.organization_id,
      service: "slack",
      organization_address: linked.address,
      conversation_id,
      agent_id: linked.agent_id,
    }, { onConflict: "conversation_id,agent_id" })
    .throwOnError();
}

async function onMemberLeft(
  ctx: Ctx,
  event: MemberLeftChannelEvent,
): Promise<void> {
  const channel = event.channel as string;
  if (!event.user || !channel) return;

  const isBot = event.user === ctx.bot_user_id;

  // Non-bot leavers must be linked members; the bot has no agent row.
  const linked = isBot ? null : await linkedAgent(ctx, event.user);
  if (!isBot && !linked) return;

  const { data: conversation } = await ctx.client
    .from("conversations")
    .select("id")
    .eq("organization_id", ctx.organization_id)
    .eq("organization_address", ctx.team)
    .eq("address", channel)
    .eq("service", "slack")
    .maybeSingle()
    .throwOnError();

  if (!conversation) return;

  // The bot leaving revokes org-wide reach. Existing messages stay, but from
  // here the container is member-gated again — anyone who could only see it
  // through the bot loses it, which is the point.
  if (isBot) {
    await setChannelFacts(ctx, conversation.id, { is_bot_member: false });

    return;
  }

  await ctx.client
    .from("conversations_agents")
    .delete()
    .eq("conversation_id", conversation.id)
    .eq("agent_id", linked!.agent_id)
    .throwOnError();
}

async function onChannelRename(
  ctx: Ctx,
  event: ChannelRenameEvent,
): Promise<void> {
  const channel = event.channel as { id: string; name?: string };
  if (!channel?.id) return;

  await ctx.client
    .from("conversations")
    .update({ name: channel.name })
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .eq("organization_address", ctx.team)
    .eq("address", channel.id)
    .throwOnError();
}

async function onChannelArchive(
  ctx: Ctx,
  event: ChannelArchiveEvent | ChannelUnarchiveEvent,
): Promise<void> {
  const channel = event.channel;
  if (!channel) return;

  await ctx.client
    .from("conversations")
    .update({
      // channel_archived, not archived: the latter is a UI preference a member
      // sets on their own view, and extra is one namespace.
      extra: { channel_archived: event.type === "channel_archive" },
    })
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .eq("organization_address", ctx.team)
    .eq("address", channel)
    .throwOnError();
}

async function onUserChange(
  ctx: Ctx,
  event: UserChangeEvent,
): Promise<void> {
  const user = event.user;
  if (!user?.id || user.is_bot) return;

  await ctx.client
    .from("contacts_addresses")
    .upsert({
      organization_id: ctx.organization_id,
      organization_address: ctx.team,
      service: "slack" as const,
      address: user.id,
      extra: {
        synced: {
          action: "add",
          name: user.profile?.display_name || user.profile?.real_name ||
            user.name,
        },
        team_id: ctx.team,
        picture: user.profile?.image_192,
      },
    }, { onConflict: "organization_id,organization_address,service,address" })
    .throwOnError();
}

// A member revoked the app from the Slack side: flip their connection to
// disconnected (same semantics as DELETE /connect — everything else stays).
async function onTokensRevoked(
  ctx: Ctx,
  event: TokensRevokedEvent,
): Promise<void> {
  for (const user of event.tokens?.oauth ?? []) {
    await ctx.client
      .from("organizations_addresses")
      .update({
        status: "disconnected",
        extra: { access_token: null, refresh_token: null },
      })
      .eq("organization_id", ctx.organization_id)
      .eq("service", "slack")
      .eq("address", `${ctx.team}:${user}`)
      .throwOnError();
  }
}

async function onAppUninstalled(ctx: Ctx): Promise<void> {
  // Anchor + every personal connection of this workspace.
  await ctx.client
    .from("organizations_addresses")
    .update({ status: "disconnected" })
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .or(`address.eq.${ctx.team},address.like.${ctx.team}:%`)
    .throwOnError();

  // Secrets on both kinds of row: the members' user tokens and the anchor's
  // bot token. A bot-only workspace has nothing matching `T…:%`, so scoping
  // this to personal rows would leave the bot token behind after uninstall.
  await ctx.client
    .from("organizations_addresses")
    .update({ extra: { access_token: null, refresh_token: null } })
    .eq("organization_id", ctx.organization_id)
    .eq("service", "slack")
    .or(`address.eq.${ctx.team},address.like.${ctx.team}:%`)
    .throwOnError();
}
