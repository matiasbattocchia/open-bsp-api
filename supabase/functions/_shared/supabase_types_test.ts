import type { ConversationExtra } from "./supabase.ts";

Deno.test("ConversationExtra supports optional handoff state", () => {
  const withoutHandoff: ConversationExtra = {
    paused: new Date(0).toISOString(),
  };

  const withHandoff: ConversationExtra = {
    paused: new Date(0).toISOString(),
    handoff: {
      status: "requested",
      requested_at: new Date(0).toISOString(),
      requested_by_agent_id: "agent-1",
      reason: "Needs human review",
    },
  };

  if (!withoutHandoff.paused || withHandoff.handoff?.status !== "requested") {
    throw new Error(
      "Expected handoff and non-handoff conversation extras to type-check",
    );
  }
});
