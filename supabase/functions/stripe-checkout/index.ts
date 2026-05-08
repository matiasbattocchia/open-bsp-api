import { createClient } from "@supabase/supabase-js";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const PRICE_MAP: Record<string, string> = {
  starter: Deno.env.get("STRIPE_STARTER_PRICE_ID")!,
  pro: Deno.env.get("STRIPE_PRO_PRICE_ID")!,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
      },
    });
  }

  try {
    // Auth: get user from JWT
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const { plan_id, organization_id, success_url, cancel_url } = await req.json();

    const price_id = PRICE_MAP[plan_id];
    if (!price_id) {
      return new Response(JSON.stringify({ error: "Invalid plan" }), { status: 400 });
    }

    // Check if org already has a Stripe customer
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      (Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
    );
    const { data: sub } = await adminClient
      .schema("billing")
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("organization_id", organization_id)
      .single();

    // Align billing cycle with calendar month:
    // - Anchor the subscription to the 1st of next month
    // - Prorate the remaining days of the current month
    const now = new Date();
    const firstOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const billingCycleAnchor = Math.floor(firstOfNextMonth.getTime() / 1000);

    // Create Stripe Checkout Session
    const params = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": price_id,
      "line_items[0][quantity]": "1",
      success_url: success_url || `${req.headers.get("origin")}/`,
      cancel_url: cancel_url || `${req.headers.get("origin")}/`,
      "metadata[organization_id]": organization_id,
      "metadata[plan_id]": plan_id,
      "metadata[user_id]": user.id,
      client_reference_id: organization_id,
      customer_email: user.email!,
      "subscription_data[billing_cycle_anchor]": String(billingCycleAnchor),
      "subscription_data[proration_behavior]": "create_prorations",
    });

    if (sub?.stripe_customer_id) {
      params.delete("customer_email");
      params.set("customer", sub.stripe_customer_id);
    }

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    const session = await stripeRes.json();
    if (session.error) {
      return new Response(JSON.stringify({ error: session.error.message }), { status: 400 });
    }

    return new Response(JSON.stringify({ url: session.url }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
});
