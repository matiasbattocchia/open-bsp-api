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

    console.log(`[invite] insert result: error=${insertError?.message || 'none'}`);

    if (insertError) {
      return json({ error: insertError.message }, 400);
    }

    // Always try to invite — if user exists, Supabase returns an error we can handle
    const siteUrl = req.headers.get("origin") || "https://app.wakit.ai";
    const signupUrl = `${siteUrl}/signup?invite=true&org=${encodeURIComponent(orgName)}`;
    console.log(`[invite] calling inviteUserByEmail for ${email}, redirectTo=${signupUrl}`);

    const { error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
      redirectTo: signupUrl,
      data: { invitation_org: orgName },
    });

    console.log(`[invite] inviteUserByEmail result: error=${inviteError?.message || 'none'}`);

    if (inviteError) {
      // "already registered" means user exists — they'll see the invitation on login
      if (inviteError.message?.includes("already") || inviteError.message?.includes("registered")) {
        return json({
          status: "invited",
          email_sent: false,
          message: `${email} already has an account and will see the invitation on login`,
        });
      }

      console.error("Failed to send invite email:", inviteError.message);
      return json({
        status: "invited",
        email_sent: false,
        message: `Invitation created but email could not be sent: ${inviteError.message}`,
      });
    }

    return json({
      status: "invited",
      email_sent: true,
      message: `Invitation sent to ${email}`,
    });

  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
