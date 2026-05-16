import { transferToHumanAgentImplementation } from "./handoff.ts";
import type { RequestContext } from "../protocols/base.ts";
import type { Database } from "../../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

class FakeQuery {
  constructor(
    private readonly table: string,
    private readonly calls: Array<
      { table: string; action: string; payload: unknown }
    >,
  ) {}

  update(payload: unknown): FakeQuery {
    this.calls.push({ table: this.table, action: "update", payload });
    return this;
  }

  insert(payload: unknown): FakeQuery {
    this.calls.push({ table: this.table, action: "insert", payload });
    return this;
  }

  eq(_column: string, _value: unknown): FakeQuery {
    return this;
  }

  throwOnError(): Promise<{ data: null; error: null }> {
    return Promise.resolve({ data: null, error: null });
  }
}

class FakeSupabase {
  readonly calls: Array<{ table: string; action: string; payload: unknown }> =
    [];

  from(table: string): FakeQuery {
    return new FakeQuery(table, this.calls);
  }
}

const context = {
  organization: { id: "org-1" },
  conversation: {
    id: "conv-1",
    service: "whatsapp",
    organization_address: "phone-number-id",
    contact_address: "5491112345678",
    group_address: null,
  },
  messages: [],
  agent: { id: "agent-1" },
} as unknown as RequestContext;

Deno.test("transferToHumanAgentImplementation updates conversation and records audit message", async () => {
  const fakeSupabase = new FakeSupabase();

  const result = await transferToHumanAgentImplementation(
    { reason: "custom color request", note: "Needs sales follow-up" },
    context,
    fakeSupabase as unknown as SupabaseClient<Database>,
  );

  if (result.status !== "requested") {
    throw new Error(`Expected requested status, got ${result.status}`);
  }

  const conversationUpdate = fakeSupabase.calls.find((call) =>
    call.table === "conversations" && call.action === "update"
  );

  if (!conversationUpdate) {
    throw new Error("Expected a conversation update");
  }

  const updatePayload = conversationUpdate.payload as {
    extra: {
      paused: string;
      handoff: {
        status: string;
        requested_at: string;
        requested_by_agent_id: string;
        reason?: string;
        note?: string;
      };
    };
  };

  if (updatePayload.extra.handoff.requested_by_agent_id !== "agent-1") {
    throw new Error("Expected handoff to record requesting agent");
  }

  if (updatePayload.extra.handoff.reason !== "custom color request") {
    throw new Error("Expected handoff reason to be preserved");
  }

  if (updatePayload.extra.paused !== updatePayload.extra.handoff.requested_at) {
    throw new Error("Expected pause timestamp to match handoff timestamp");
  }

  const messageInsert = fakeSupabase.calls.find((call) =>
    call.table === "messages" && call.action === "insert"
  );

  if (!messageInsert) {
    throw new Error("Expected an internal audit message insert");
  }

  const insertPayload = messageInsert.payload as {
    conversation_id: string;
    direction: string;
    content: {
      type: string;
      kind: string;
      data: { event?: string };
    };
  };

  if (insertPayload.conversation_id !== "conv-1") {
    throw new Error(
      "Expected audit message to target the current conversation",
    );
  }

  if (insertPayload.direction !== "internal") {
    throw new Error("Expected audit message to be internal");
  }

  if (
    insertPayload.content.type !== "data" ||
    insertPayload.content.kind !== "data" ||
    insertPayload.content.data.event !== "human_handoff_requested"
  ) {
    throw new Error("Expected audit message to use handoff data content");
  }
});

Deno.test("transferToHumanAgentImplementation accepts missing reason and note", async () => {
  const fakeSupabase = new FakeSupabase();

  await transferToHumanAgentImplementation(
    {},
    context,
    fakeSupabase as unknown as SupabaseClient<Database>,
  );

  const conversationUpdate = fakeSupabase.calls.find((call) =>
    call.table === "conversations" && call.action === "update"
  );

  if (!conversationUpdate) {
    throw new Error("Expected a conversation update");
  }

  const updatePayload = conversationUpdate.payload as {
    extra: { handoff: { reason?: string; note?: string } };
  };

  if (
    "reason" in updatePayload.extra.handoff ||
    "note" in updatePayload.extra.handoff
  ) {
    throw new Error("Expected empty optional fields to be omitted");
  }
});
