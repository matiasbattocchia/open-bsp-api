import { createClient as createClientBase } from "@supabase/supabase-js";
import type { Database } from "./types/database_types.ts";

export function createClient(req: Request) {
  if (!Deno.env.get("SUPABASE_URL")) {
    throw new Error("Undefined SUPABASE_URL env var.");
  }

  if (!Deno.env.get("SUPABASE_ANON_KEY")) {
    throw new Error("Undefined SUPABASE_ANON_KEY env var.");
  }

  const authHeader = req.headers.get("Authorization");

  if (!authHeader) {
    throw new Error("Missing Authorization header");
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    throw new Error("Invalid Authorization header format");
  }

  return createClientBase<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      auth: { persistSession: false },
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  );
}

export function createApiClient(req: Request) {
  if (!Deno.env.get("SUPABASE_URL")) {
    throw new Error("Undefined SUPABASE_URL env var.");
  }

  if (!Deno.env.get("SUPABASE_ANON_KEY")) {
    throw new Error("Undefined SUPABASE_ANON_KEY env var.");
  }

  const authHeader = req.headers.get("Authorization");

  if (!authHeader) {
    throw new Error("Missing Authorization header");
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    throw new Error("Invalid Authorization header format");
  }

  return createClientBase<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      auth: { persistSession: false },
      global: {
        headers: {
          "api-key": token,
        },
      },
    },
  );
}

// API-key-scoped client from a raw key (no request needed): forwards the org
// API key in the `api-key` header so RLS resolves the org via the api-key
// path. auth.uid() stays null; the key's role bounds access.
export function createApiClientFromKey(apiKey: string) {
  if (!Deno.env.get("SUPABASE_URL")) {
    throw new Error("Undefined SUPABASE_URL env var.");
  }

  if (!Deno.env.get("SUPABASE_ANON_KEY")) {
    throw new Error("Undefined SUPABASE_ANON_KEY env var.");
  }

  return createClientBase<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      auth: { persistSession: false },
      global: {
        headers: {
          "api-key": apiKey,
        },
      },
    },
  );
}

export function createUnsecureClient() {
  if (!Deno.env.get("SUPABASE_URL")) {
    throw new Error("Undefined SUPABASE_URL env var.");
  }

  if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    throw new Error("Undefined SUPABASE_SERVICE_ROLE_KEY env var.");
  }

  return createClientBase<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {
      auth: { persistSession: false },
    },
  );
}
