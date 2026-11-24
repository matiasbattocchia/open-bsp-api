import { createClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/functions/_shared/db_types.ts";

export interface Config {
  url: string;
  anonKey: string;
  apiKey: string;
  organizationId: string;
}

export function readConfig(env: (name: string) => string | undefined): Config {
  function required(name: string): string {
    const value = env(name)?.trim();
    if (!value) throw new Error(`Set ${name} before running this example`);
    return value;
  }
  return {
    url: required("SUPABASE_URL"),
    anonKey: required("SUPABASE_ANON_KEY"),
    apiKey: required("OPENBSP_API_KEY"),
    organizationId: required("OPENBSP_ORGANIZATION_ID"),
  };
}

export function createOpenBspClient(config: Config, fetcher = fetch) {
  return createClient<Database>(config.url, config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { "api-key": config.apiKey }, fetch: fetcher },
  });
}

export async function recentIncoming(
  client: ReturnType<typeof createOpenBspClient>,
  organizationId: string,
) {
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
    const messages = await recentIncoming(
      createOpenBspClient(config),
      config.organizationId,
    );
    console.log(JSON.stringify(messages, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Request failed");
    Deno.exitCode = 1;
  }
}
