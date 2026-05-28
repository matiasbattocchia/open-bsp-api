import { createClient } from "@supabase/supabase-js";
import { getServiceRoleKey } from "../_shared/supabase.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    // Authenticate the caller
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const { organization_id, email, role } = await req.json();

    if (!organization_id || !email) {
      return json({ error: "organization_id and email are required" }, 400);
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      getServiceRoleKey(),
    );

    // Get organization name
    const { data: org } = await adminClient
      .from("organizations")
      .select("name")
      .eq("id", organization_id)
      .single();

    const orgName = org?.name || "an organization";

    // Check if the user has an account — only allow inviting existing users
    const { data: { users } } = await adminClient.auth.admin.listUsers();
    const existingUser = users?.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    );

    if (!existingUser) {
      return json({
        error: "User must create an account before being invited",
      });
    }

    // Create the invitation in agents table
    const { error: insertError } = await adminClient
      .from("agents")
      .insert({
        organization_id,
        name: email.split("@")[0],
        ai: false,
        extra: {
          role: role || "member",
          invitation: {
            email,
            organization_name: orgName,
            status: "pending",
          },
        },
      });

    if (insertError) {
      return json({ error: insertError.message }, 400);
    }

    return json({
      status: "invited",
      message: `${email} verá la invitación a ${orgName} cuando inicie sesión`,
    });

  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
