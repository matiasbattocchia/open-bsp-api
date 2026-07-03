// Public base URL of the Edge Functions, as reached from the outside world —
// used to build the OAuth/MCP discovery URLs (resource, metadata). In hosted
// Supabase, SUPABASE_URL is the public project origin
// (https://<ref>.supabase.co), so the functions live at
// <SUPABASE_URL>/functions/v1. Local SUPABASE_URL is the internal gateway over
// http (not the URL a remote client calls), so we fall back to the local stack
// origin there.
export function functionsBaseUrl(): string {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (supabaseUrl.startsWith("https://")) {
    return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1`;
  }
  return "http://127.0.0.1:54321/functions/v1";
}

// Public base URL of Supabase Auth — the native OAuth 2.1 server (the MCP
// connector's authorization server). Same origin logic as functionsBaseUrl.
export function authBaseUrl(): string {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (supabaseUrl.startsWith("https://")) {
    return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
  }
  return "http://127.0.0.1:54321/auth/v1";
}
