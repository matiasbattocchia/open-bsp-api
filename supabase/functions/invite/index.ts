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

  try {
    // Authenticate the caller
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { organization_id, email, role } = await req.json();

    if (!organization_id || !email) {
      return new Response(JSON.stringify({ error: "organization_id and email are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use service role client for admin operations
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      getServiceRoleKey(),
    );

    // Get organization name for the email
    const { data: org } = await adminClient
      .from("organizations")
      .select("name")
      .eq("id", organization_id)
      .single();

    const orgName = org?.name || "an organization";

    // Check if user exists in auth
    const { data: existingUsers } = await adminClient.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    );

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
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If user doesn't exist, invite them via Supabase Auth (sends magic link email)
    if (!existingUser) {
      const siteUrl = req.headers.get("origin") || "https://app.wakit.ai";

      const { error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
        redirectTo: siteUrl,
        data: {
          invitation_org: orgName,
        },
      });

      if (inviteError) {
        console.error("Failed to send invite email:", inviteError);
        // Don't fail the whole operation — the invitation was created
        return new Response(JSON.stringify({
          status: "invited",
          email_sent: false,
          message: `Invitation created but email could not be sent: ${inviteError.message}`,
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        status: "invited",
        email_sent: true,
        message: `Invitation sent to ${email}`,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // User already exists — no email needed, they'll see it when they log in
    return new Response(JSON.stringify({
      status: "invited",
      email_sent: false,
      message: `${email} already has an account and will see the invitation on login`,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
