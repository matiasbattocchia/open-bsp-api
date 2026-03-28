/**
 * OAuth loopback flow for Supabase Auth (Google SSO).
 *
 * On first run, opens a browser for Google OAuth, gets a Supabase JWT,
 * and persists the session. Subsequent runs load from disk and refresh
 * automatically.
 *
 * Pattern follows open-bsp-ui's login.tsx and client.ts.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, STATE_DIR, SESSION_FILE } from "./config.ts";

type SavedSession = {
  access_token: string;
  refresh_token: string;
};

function loadSavedSession(): SavedSession | null {
  try {
    const raw = readFileSync(SESSION_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.access_token && parsed.refresh_token) return parsed;
    return null;
  } catch {
    return null;
  }
}

function saveSession(session: SavedSession): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = SESSION_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n", {
    mode: 0o600,
  });
  Deno.renameSync(tmp, SESSION_FILE);
}

/**
 * Start a local HTTP server, open the browser for Google OAuth,
 * and wait for the callback with tokens.
 */
async function oauthLoopback(
  supabase: SupabaseClient
): Promise<SavedSession> {
  // Use Deno.serve with port 0 to get a free port
  let resolveSession: (s: SavedSession) => void;
  let rejectSession: (e: Error) => void;
  const sessionPromise = new Promise<SavedSession>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });

  let server: Deno.HttpServer;
  let settled = false;

  server = Deno.serve({ port: 0, onListen() {} }, async (request) => {
    const url = new URL(request.url);

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");

      if (code) {
        const { data: sessionData, error: sessionError } =
          await supabase.auth.exchangeCodeForSession(code);

        if (sessionError || !sessionData.session) {
          if (!settled) {
            settled = true;
            rejectSession(
              new Error(
                `Code exchange failed: ${sessionError?.message ?? "no session"}`
              )
            );
          }
          return new Response(
            "<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>",
            { headers: { "content-type": "text/html" } }
          );
        }

        if (!settled) {
          settled = true;
          resolveSession({
            access_token: sessionData.session.access_token,
            refresh_token: sessionData.session.refresh_token,
          });
        }
        return new Response(
          "<html><body><h2>Signed in!</h2><p>You can close this tab and return to Claude Code.</p></body></html>",
          { headers: { "content-type": "text/html" } }
        );
      }

      // Hash-based redirect fallback — serve a page that extracts tokens
      return new Response(
        `<html><body><script>
          const hash = window.location.hash.substring(1);
          const params = new URLSearchParams(hash);
          const access_token = params.get('access_token');
          const refresh_token = params.get('refresh_token');
          if (access_token) {
            fetch('/token?access_token=' + encodeURIComponent(access_token) + '&refresh_token=' + encodeURIComponent(refresh_token))
              .then(() => { document.body.innerHTML = '<h2>Signed in!</h2><p>You can close this tab.</p>'; });
          } else {
            document.body.innerHTML = '<h2>Authentication failed</h2><p>No tokens received.</p>';
          }
        </script><p>Processing...</p></body></html>`,
        { headers: { "content-type": "text/html" } }
      );
    }

    if (url.pathname === "/token") {
      const accessToken = url.searchParams.get("access_token");
      const refreshToken = url.searchParams.get("refresh_token");
      if (accessToken && refreshToken && !settled) {
        settled = true;
        resolveSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        return new Response("ok");
      }
      return new Response("missing tokens", { status: 400 });
    }

    return new Response("not found", { status: 404 });
  });

  const port = (server.addr as Deno.NetAddr).port;
  const redirectTo = `http://localhost:${port}/callback`;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo,
      skipBrowserRedirect: true,
    },
  });

  if (error || !data.url) {
    await server.shutdown();
    throw new Error(`Failed to get OAuth URL: ${error?.message ?? "no url"}`);
  }

  console.error(`openbsp: opening browser for Google sign-in...`);
  console.error(`  If the browser doesn't open, visit: ${data.url}`);

  // Open browser
  const openCmd =
    Deno.build.os === "darwin"
      ? "open"
      : Deno.build.os === "windows"
        ? "start"
        : "xdg-open";
  try {
    const cmd = new Deno.Command(openCmd, { args: [data.url] });
    cmd.spawn();
  } catch {
    // Browser open failed — user can visit the URL manually
  }

  // Timeout after 5 minutes
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectSession(new Error("OAuth callback timed out after 5 minutes"));
    }
  }, 5 * 60 * 1000);

  try {
    const session = await sessionPromise;
    clearTimeout(timeout);
    await server.shutdown();
    return session;
  } catch (err) {
    clearTimeout(timeout);
    await server.shutdown();
    throw err;
  }
}

/**
 * Authenticate and return a ready-to-use Supabase client.
 * Tries saved session first, falls back to OAuth loopback.
 */
export async function authenticate(): Promise<SupabaseClient> {
  const config = loadConfig();
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: false,
      autoRefreshToken: true,
      persistSession: false, // we manage persistence ourselves
    },
  });

  // Reconnect strategy (from open-bsp-ui)
  supabase.realtime.reconnectAfterMs = (attempt: number) => {
    return Math.min(10 * 1000, attempt * 1000);
  };

  // Persist refreshed tokens
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      saveSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    }
  });

  // Try saved session
  const saved = loadSavedSession();
  if (saved) {
    const { error } = await supabase.auth.setSession({
      access_token: saved.access_token,
      refresh_token: saved.refresh_token,
    });

    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        console.error(
          `openbsp: authenticated as ${user.email ?? user.id}`
        );
        return supabase;
      }
    }

    console.error(
      `openbsp: saved session expired or invalid, re-authenticating...`
    );
  }

  // OAuth loopback
  const session = await oauthLoopback(supabase);
  saveSession(session);

  // Set the session we just got
  await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  console.error(
    `openbsp: authenticated as ${user?.email ?? user?.id ?? "unknown"}`
  );

  return supabase;
}
