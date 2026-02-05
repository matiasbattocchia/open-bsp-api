import { createUnsecureClient } from "../_shared/supabase.ts";

interface AuthResult {
  orgId: string;
  token: string;
}

export async function validateApiKey(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new Error("Missing Authorization header");
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    throw new Error("Invalid Authorization header format");
  }

  // Use unsecure client to validate API key (service role bypasses RLS)
  const supabase = createUnsecureClient();

  const { data, error } = await supabase
    .from("api_keys")
    .select("organization_id")
    .eq("key", token)
    .single();

  if (error || !data) {
    console.error("Auth error:", error);
    throw new Error("Invalid API Key");
  }

  return { orgId: data.organization_id, token };
}
