// The inbox and replies through the remote server: the plugin's reading
// (_shared/inbox.ts), in UTC — the server doesn't know the reader's zone. A
// person's inbox picks up where it left off, kept on their membership; an API
// key keeps no place, so it passes `since` itself.
import {
  createLookup,
  FIRST_LOOK_BACK_MS,
  readConversation,
  type Reader,
  readInbox,
  resolveAccounts,
} from "../_shared/inbox.ts";
import type { MessageInsert } from "../_shared/supabase.ts";
import { type Caller, type Key, remember, workspace } from "./caller.ts";

const digits = (text: string | null) => (text ?? "").replace(/\D/g, "");

type Addressed = {
  organization_address: string;
  conversation_address: string | null;
};

/**
 * What an API key narrowed to by header (Allowed-Accounts, Allowed-Contacts:
 * phone numbers): only those accounts' conversations, with those contacts.
 */
async function keyLimits(
  key: Key,
): Promise<((row: Addressed) => boolean) | undefined> {
  if (!key.allowedAccounts.length && !key.allowedContacts.length) return;

  let accounts: Set<string> | undefined;
  if (key.allowedAccounts.length) {
    const { data } = await key.supabase
      .from("organizations_addresses")
      .select("address, extra")
      .eq("organization_id", key.orgId)
      .throwOnError();
    accounts = new Set(
      data
        .filter((a) =>
          key.allowedAccounts.includes(
            digits(
              (a.extra as { phone_number?: string } | null)?.phone_number ??
                null,
            ),
          )
        )
        .map((a) => a.address),
    );
  }

  return (row) =>
    (!accounts || accounts.has(row.organization_address)) &&
    (!key.allowedContacts.length ||
      key.allowedContacts.includes(digits(row.conversation_address)));
}

/** The conversation, if the caller may see it. */
async function conversation(caller: Caller, orgId: string, id: string) {
  const { data: conv } = await caller.supabase
    .from("conversations")
    .select("service, organization_address, address, name")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle()
    .throwOnError();

  const limits = caller.kind === "key" ? await keyLimits(caller) : undefined;
  if (
    !conv ||
    (limits &&
      !limits({
        organization_address: conv.organization_address,
        conversation_address: conv.address,
      }))
  ) {
    throw new Error(`Conversation ${id} not found`);
  }
  return conv;
}

export async function inbox(
  caller: Caller,
  args: { conversation_id?: string; since?: string },
): Promise<string> {
  const { orgId, membership } = await workspace(caller);
  const reader: Reader = {
    orgId,
    agentId: membership?.agentId,
    // Named even once disconnected: what came before still reads by them.
    accounts: await resolveAccounts(caller.supabase, orgId, {
      connected: false,
    }),
    timeZone: "UTC",
  };

  if (args.conversation_id) {
    await conversation(caller, orgId, args.conversation_id);
    return await readConversation(
      caller.supabase,
      reader,
      args.conversation_id,
    );
  }

  if (args.since && isNaN(Date.parse(args.since))) {
    throw new Error("since must be an ISO 8601 time, e.g. 2026-11-24T09:00Z");
  }
  // As given: a cursor carries microseconds, which a Date would drop.
  const since = args.since?.trim();

  const { text, cursor } = await readInbox(caller.supabase, reader, {
    since: since ?? membership?.inboxCursor ??
      new Date(Date.now() - FIRST_LOOK_BACK_MS).toISOString(),
    visible: caller.kind === "key" ? await keyLimits(caller) : undefined,
  });

  // A person's inbox moves on, unless they asked for a time of their own.
  if (caller.kind === "person" && !since && cursor) {
    await remember(caller, membership!, { inbox_cursor: cursor });
  }
  if (caller.kind === "key" && cursor) {
    return `${text}\n\nNext check: pass since ${cursor} to get only what came after.`;
  }
  return text;
}

export async function reply(
  caller: Caller,
  args: { conversation_id: string; text: string; reply_to?: string },
): Promise<string> {
  const { orgId, membership } = await workspace(caller);
  if (!args.text) throw new Error("text is required");

  // The conversation says where the message goes: its service, the account
  // that holds it, and the peer.
  const conv = await conversation(caller, orgId, args.conversation_id);

  // A reply names what it answers by the service's id for it (a local row,
  // which has none, by its own id); Slack posts it in that message's thread.
  let re_message_id: string | undefined;
  if (args.reply_to) {
    const { data: answered } = await caller.supabase
      .from("messages")
      .select("id, external_id")
      .eq("organization_id", orgId)
      .eq("conversation_id", args.conversation_id)
      .eq("id", args.reply_to)
      .maybeSingle()
      .throwOnError();

    if (!answered) {
      throw new Error(
        `Message ${args.reply_to} not found in this conversation`,
      );
    }
    re_message_id = answered.external_id ?? answered.id;
  }

  const insert = {
    organization_id: orgId,
    conversation_id: args.conversation_id,
    service: conv.service,
    organization_address: conv.organization_address,
    conversation_address: conv.address,
    sender_address: null,
    // Sent as the person: Slack posts it with their own identity. A key's
    // message is the account's.
    agent_id: membership?.agentId ?? null,
    content: {
      version: "1",
      type: "text",
      kind: "text",
      text: args.text,
      ...(re_message_id && { re_message_id }),
    },
  } as MessageInsert;

  // The dispatch trigger routes it to the service (same as open-bsp-ui).
  const { error } = await caller.supabase.from("messages").insert(insert);
  if (error) {
    throw new Error(
      `not sent: ${error.message}${error.hint ? ` (${error.hint})` : ""}`,
    );
  }

  const to = conv.name ??
    (await createLookup(caller.supabase).contact(
      { ...conv, organization_id: orgId },
      conv.address,
    )).name;
  return `Queued on ${conv.service}, to ${to}.`;
}
