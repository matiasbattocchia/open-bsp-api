// The whole API as the caller: PostgREST and the Edge Functions, with their
// own credentials (a person's token, or the API key), so RLS bounds what each
// one reaches. `query` reads; `change` writes, so that a client can let reads
// through and ask before each change.
import type { Caller } from "./caller.ts";

const PREFIXES = ["/rest/v1/", "/functions/v1/"];

// Reads that a route takes by PUT, for the body they need.
const READS: [string, string][] = [
  ["PUT", "/functions/v1/whatsapp-management/templates"],
];

// What a client takes in one result; the rest is cut.
const MAX_RESULT = 60_000;

export const isRead = (method: string, path: string) =>
  method === "GET" || method === "HEAD" ||
  READS.some(([m, p]) => m === method && path.split("?")[0] === p);

export type ApiResponse = { ok: boolean; status: number; data: unknown };

/** A call to the API as the caller. */
export async function request(
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const base = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  // Resolved, so `..` can't step outside the API.
  const url = new URL(path, base);
  if (
    url.origin !== new URL(base).origin ||
    !PREFIXES.some((p) => url.pathname.startsWith(p))
  ) {
    throw new Error(`path must start with one of: ${PREFIXES.join(", ")}`);
  }

  // The credentials are the caller's own, never the arguments'.
  const extra = Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      !["authorization", "apikey", "api-key"].includes(name.toLowerCase())
    ),
  );

  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...extra,
      apikey: anon,
      ...(caller.kind === "person"
        ? { Authorization: `Bearer ${caller.token}` }
        : { Authorization: `Bearer ${anon}`, "api-key": caller.key }),
    },
    ...(body !== undefined && method !== "GET" && method !== "HEAD"
      ? { body: JSON.stringify(body) }
      : {}),
  });
  const text = await response.text();

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }

  return { ok: response.ok, status: response.status, data };
}

/** An Edge Function call that throws on failure, with the API's message. */
export async function callFunction<T>(
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await request(caller, method, `/functions/v1/${path}`, body);

  if (!res.ok) {
    const message = (res.data as { message?: string; error?: string })
      ?.message ?? (res.data as { error?: string })?.error;
    throw new Error(
      res.status === 402
        ? "the organization has reached its plan's limit of connected accounts"
        : message ?? `${path} answered ${res.status}`,
    );
  }

  return res.data as T;
}

/** The query and change tools: the API's answer, as text. */
export async function callApi(
  caller: Caller,
  args: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{ text: string; isError: boolean }> {
  const { ok, status, data } = await request(
    caller,
    args.method,
    args.path,
    args.body,
    args.headers,
  );

  let text = JSON.stringify(ok ? data : { status, error: data }, null, 2);
  if (text.length > MAX_RESULT) {
    text = `${
      text.slice(0, MAX_RESULT)
    }\n… cut at ${MAX_RESULT} characters of ${text.length}: ask for less (select, limit).`;
  }
  return { text, isError: !ok };
}
