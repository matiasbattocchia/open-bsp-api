/**
 * OAuth loopback flow for Supabase Auth (Google SSO).
 *
 * Split into non-interactive session restore (used at boot) and an
 * interactive login that the server triggers on demand (login tool /
 * elicitation), so the browser never pops without the user asking.
 *
 * Pattern follows open-bsp-ui's login.tsx and client.ts.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig, SESSION_FILE, STATE_DIR } from "./config.ts";

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

export function clearSavedSession(): void {
  try {
    rmSync(SESSION_FILE);
  } catch {
    // already gone
  }
}

/**
 * Build the Supabase client. Persists refreshed tokens to disk but never
 * starts an interactive flow.
 */
export function createSupabaseClient(): SupabaseClient {
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

  return supabase;
}

/**
 * Try to restore the saved session. Returns the signed-in user's
 * email/id, or null if there is no usable session. Never interactive.
 */
export async function restoreSession(
  supabase: SupabaseClient,
): Promise<string | null> {
  const saved = loadSavedSession();
  if (!saved) return null;

  const { error } = await supabase.auth.setSession({
    access_token: saved.access_token,
    refresh_token: saved.refresh_token,
  });
  if (error) return null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  return user.email ?? user.id;
}

export type PendingLogin = {
  /** The Google sign-in URL to show the user. */
  url: string;
  /** Resolves when the OAuth callback lands (session is set + saved). */
  session: Promise<string>;
  /** Abort the flow and free the loopback port. */
  cancel: (reason?: string) => void;
};

/**
 * Start an interactive login: spin up the loopback server, build the
 * OAuth URL, and try to open a browser. Returns immediately so the
 * caller can surface the URL (elicitation / tool result); `session`
 * resolves with the signed-in user's email/id once the callback lands.
 */
export async function startLogin(
  supabase: SupabaseClient,
): Promise<PendingLogin> {
  let resolveSession: (s: SavedSession) => void;
  let rejectSession: (e: Error) => void;
  const sessionPromise = new Promise<SavedSession>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });

  let settled = false;

  const server = Deno.serve({ port: 0, onListen() {} }, async (request) => {
    const url = new URL(request.url);

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");

      if (code) {
        const { data: sessionData, error: sessionError } = await supabase.auth
          .exchangeCodeForSession(code);

        if (sessionError || !sessionData.session) {
          if (!settled) {
            settled = true;
            rejectSession(
              new Error(
                `Code exchange failed: ${
                  sessionError?.message ?? "no session"
                }`,
              ),
            );
          }
          return new Response(
            "<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>",
            { headers: { "content-type": "text/html" } },
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
          { headers: { "content-type": "text/html" } },
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
        { headers: { "content-type": "text/html" } },
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

  // Best-effort browser open — the caller also surfaces the URL in the TUI.
  const openCmd = Deno.build.os === "darwin"
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

  // Backstop timeout — the loopback must not linger forever.
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectSession(new Error("Sign-in timed out after 10 minutes"));
    }
  }, 10 * 60 * 1000);

  const cancel = (reason = "Sign-in cancelled") => {
    if (!settled) {
      settled = true;
      rejectSession(new Error(reason));
    }
  };

  const session = sessionPromise
    .then(async (s) => {
      saveSession(s);
      await supabase.auth.setSession({
        access_token: s.access_token,
        refresh_token: s.refresh_token,
      });
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user?.email ?? user?.id ?? "unknown";
    })
    .finally(() => {
      clearTimeout(timeout);
      server.shutdown().catch(() => {});
    });

  return { url: data.url, session, cancel };
}
