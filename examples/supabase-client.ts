import { createClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/functions/_shared/db_types.ts";

export interface Config {
  url: string;
  publishableKey: string;
  apiKey: string;
}

// The columns read. A column the schema no longer has fails the type check
// here: supabase-js types an unknown column as an error, not as a compile error.
export type Message = Pick<
  Database["public"]["Tables"]["messages"]["Row"],
  "id" | "timestamp" | "conversation_address" | "sender_address" | "content"
>;

export function readConfig(env: (name: string) => string | undefined): Config {
  function required(name: string): string {
    const value = env(name)?.trim();
    if (!value) throw new Error(`Set ${name} before running this example`);
    return value;
  }
  return {
    url: required("SUPABASE_URL"),
    publishableKey: required("SUPABASE_PUBLISHABLE_KEY"),
    apiKey: required("OPENBSP_API_KEY"),
  };
}

export function createOpenBspClient(config: Config, fetcher = fetch) {
  return createClient<Database>(config.url, config.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { "api-key": config.apiKey }, fetch: fetcher },
  });
}

type OpenBspClient = ReturnType<typeof createOpenBspClient>;

// An API key belongs to one organization. A key the deployment doesn't know
// isn't refused: row-level security hides every row from it, and its inbox
// would read as empty. The organization it can see tells the two apart.
export async function keyOrganization(client: OpenBspClient): Promise<string> {
  const { data, error } = await client
    .from("organizations")
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`Could not read the organization: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      "The OpenBSP API key matches no organization on this deployment",
    );
  }
  return data.id;
}

export async function recentIncoming(
  client: OpenBspClient,
): Promise<Message[]> {
  const organizationId = await keyOrganization(client);

  const { data, error } = await client
    .from("messages")
    .select("id,timestamp,conversation_address,sender_address,content")
    .eq("organization_id", organizationId)
    .eq("service", "whatsapp")
    .not("sender_address", "is", null)
    .order("timestamp", { ascending: false })
    .limit(20);

  if (error) throw new Error(`Could not read messages: ${error.message}`);
  return data;
}

if (import.meta.main) {
  try {
    const config = readConfig((name) => Deno.env.get(name));
    const messages = await recentIncoming(createOpenBspClient(config));
    console.log(JSON.stringify(messages, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Request failed");
    Deno.exitCode = 1;
  }
}
