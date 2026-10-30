import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types/database_types.ts";
import type { Json } from "./db_types.ts";
import * as log from "./logger.ts";

/**
 * Persists the result of dispatching an outgoing message: stamps the
 * service-assigned `external_id`, merges in the given status, and retracts the
 * arm bit — the service has the message now, so the row is no longer something
 * to send. `pending` is a merge-patch null (RFC 7396), which REMOVES the key.
 *
 * Retracting is the writer's job, not a trigger's: only the caller knows the
 * send actually happened. The retry sweep already skips rows carrying
 * `accepted`, so this changes no dispatch behaviour — it stops outgoing rows
 * from reading as simultaneously queued and sent to everyone downstream (the
 * UI, `notify_webhook`, anything asking whether a message is still in flight).
 *
 * Only the success path. A transient failure keeps the arm bit deliberately —
 * that is what the sweep re-fires on.
 *
 * The id is stamped by `commit_dispatched_message`, in one transaction: a
 * webhook for the same `external_id` can land first (a `sent`/`read` status,
 * or an echo) and insert a status-only row of its own, and the function folds
 * that row's status into ours and deletes it. Our row survives, carrying the
 * authoritative content, the agent metadata and the id the UI/agent already
 * rendered. A webhook landing mid-merge waits for it and updates our row.
 *
 * The messages realtime/notify trigger fires on insert/update, not delete, so
 * removing the webhook's row is not pushed to clients: a UI that already
 * rendered it may keep showing it until a refresh.
 *
 * `externalId` is optional: some sends (e.g. Instagram reactions) yield no id
 * to track, and the status is merged onto our row alone.
 */
export async function commitDispatchedMessage({
  client,
  messageId,
  externalId,
  status,
}: {
  client: SupabaseClient<Database>;
  messageId: string;
  externalId?: string;
  status: Record<string, Json>;
}): Promise<void> {
  // Caller-stated keys win, so a dispatcher that has a reason to keep the row
  // armed can say so.
  const patch: Record<string, Json> = { pending: null, ...status };

  const { data: merged } = await client
    .rpc("commit_dispatched_message", {
      message_id: messageId,
      status: patch,
      ...(externalId && { external_id: externalId }),
    })
    .throwOnError();

  if (merged) {
    log.warn("A webhook row already owned this external_id; merged it", {
      message_id: messageId,
      external_id: externalId,
    });
  }
}
