import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createUnsecureClient } from "../_shared/supabase.ts";
import * as log from "../_shared/logger.ts";

/**
 * Storage garbage collector.
 *
 * Organizations are deleted immediately; their relational rows cascade away, but
 * `storage.objects` has no FK to `organizations` (the org id only lives in the
 * path `organizations/<org_id>/attachments/<file_id>`), so the files are left
 * orphaned. This function — invoked hourly by pg_cron — discovers org folders in
 * the `media` bucket whose organization no longer exists and removes them.
 *
 * Self-healing: it reconciles against the current `organizations` table, so it
 * also cleans up anything orphaned by means other than an org deletion.
 *
 * Bounded + restartable: at most MAX_DELETES_PER_RUN objects are removed per
 * invocation. Because it deletes what it lists (no offset), the next run simply
 * resumes where this one stopped.
 */

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const BUCKET = "media";
const LIST_LIMIT = 1000; // max page size for Storage list()
const MAX_DELETES_PER_RUN = 10000; // upper bound of objects removed per invocation

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Budget = { left: number };

/** Lists the immediate org-id folders under `organizations/` (paginated). */
async function listOrgFolders(client: SupabaseClient): Promise<string[]> {
  const names: string[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await client.storage
      .from(BUCKET)
      .list("organizations", { limit: LIST_LIMIT, offset });

    if (error) throw error;
    if (!data || data.length === 0) break;

    // Folders are returned with a null id; files have a non-null id.
    for (const item of data) {
      if (item.id === null && UUID_RE.test(item.name)) names.push(item.name);
    }

    if (data.length < LIST_LIMIT) break;
    offset += LIST_LIMIT;
  }

  return names;
}

/**
 * Recursively removes every object under `prefix`, depleting `budget`. Deletes
 * what it lists (no offset) so re-listing returns the next batch until empty.
 */
async function drainPrefix(
  client: SupabaseClient,
  prefix: string,
  budget: Budget,
): Promise<number> {
  let removed = 0;

  while (budget.left > 0) {
    const { data, error } = await client.storage
      .from(BUCKET)
      .list(prefix, { limit: LIST_LIMIT });

    if (error) throw error;
    if (!data || data.length === 0) break;

    const files: string[] = [];
    const folders: string[] = [];

    for (const item of data) {
      if (item.id === null) folders.push(`${prefix}/${item.name}`);
      else files.push(`${prefix}/${item.name}`);
    }

    // Drain nested folders first (rare; v1 paths are flat under attachments).
    for (const folder of folders) {
      removed += await drainPrefix(client, folder, budget);
      if (budget.left <= 0) return removed;
    }

    if (files.length === 0) break; // only (now-drained) folders remained

    const batch = files.slice(0, budget.left);
    const { error: removeError } = await client.storage
      .from(BUCKET)
      .remove(batch);

    if (removeError) throw removeError;

    removed += batch.length;
    budget.left -= batch.length;

    // Last page and we removed all of it: nothing left under this prefix.
    if (files.length < LIST_LIMIT && batch.length === files.length) break;
  }

  return removed;
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();

  // 1. Which org folders currently exist in storage?
  const orgFolders = await listOrgFolders(client);

  if (orgFolders.length === 0) {
    return Response.json({ orphans: 0, removed: 0, done: true });
  }

  // 2. Which of those orgs are gone? (one round-trip)
  const { data: existing } = await client
    .from("organizations")
    .select("id")
    .in("id", orgFolders)
    .throwOnError();

  const existingIds = new Set((existing ?? []).map((o) => o.id));
  const orphans = orgFolders.filter((id) => !existingIds.has(id));

  if (orphans.length === 0) {
    return Response.json({ orphans: 0, removed: 0, done: true });
  }

  // 3. Drain each orphan up to the per-run budget. Triggers on storage.objects
  //    fire per row; billing.update_storage_usage() skips usage accounting when
  //    the org no longer exists, so these deletes never touch billing.
  const budget: Budget = { left: MAX_DELETES_PER_RUN };
  let removed = 0;
  let drained = 0;

  for (const orgId of orphans) {
    if (budget.left <= 0) break;
    removed += await drainPrefix(client, `organizations/${orgId}`, budget);
    drained++;
  }

  const done = budget.left > 0; // budget left ⇒ every orphan fully drained
  log.info("storage-gc sweep", {
    orphans: orphans.length,
    drained,
    removed,
    done,
  });

  return Response.json({ orphans: orphans.length, drained, removed, done });
});
