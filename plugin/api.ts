/**
 * Authenticated HTTP to the OpenBSP API: PostgREST and the Edge Functions.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "./config.ts";

export const ALLOWED_PATH_PREFIXES = ["/rest/v1/", "/functions/v1/"];

export type ApiResponse = { ok: boolean; status: number; data: unknown };

export async function request(
  supabase: SupabaseClient,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const config = loadConfig();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const reqHeaders: Record<string, string> = {
    apikey: config.supabaseAnonKey,
    "Content-Type": "application/json",
    ...headers,
  };
  if (session?.access_token) {
    reqHeaders["Authorization"] = `Bearer ${session.access_token}`;
  }

  const response = await fetch(`${config.supabaseUrl}${path}`, {
    method,
    headers: reqHeaders,
    ...(body !== undefined && method !== "GET" && method !== "HEAD"
      ? { body: JSON.stringify(body) }
      : {}),
  });
  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }

  return { ok: response.ok, status: response.status, data };
}

/** An Edge Function call that throws on failure, with the API's message. */
export async function callFunction<T>(
  supabase: SupabaseClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await request(supabase, method, `/functions/v1/${path}`, body);

  if (!res.ok) {
    const message = (res.data as { message?: string })?.message;
    throw new Error(
      res.status === 402
        ? "the organization has reached its plan's limit of connected accounts"
        : message ?? `${path} answered ${res.status}`,
    );
  }

  return res.data as T;
}
