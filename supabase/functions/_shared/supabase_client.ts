import { createClient as createClientBase } from "@supabase/supabase-js";
import type { Database } from "./types/supabase_database.ts";

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
