import { createClient } from "@supabase/supabase-js";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const PRICE_TO_PLAN: Record<string, { plan_id: string; tier_id: string }> = {
  [Deno.env.get("STRIPE_STARTER_PRICE_ID")!]: { plan_id: "starter", tier_id: "starter" },
  [Deno.env.get("STRIPE_PRO_PRICE_ID")!]: { plan_id: "pro", tier_id: "pro" },
};

async function verifySignature(body: string, signature: string): Promise<boolean> {
  const parts = signature.split(",").reduce((acc, part) => {
    const [key, value] = part.split("=");
    acc[key] = value;
    return acc;
  }, {} as Record<string, string>);

  const timestamp = parts["t"];
  const expectedSig = parts["v1"];
  const payload = `${timestamp}.${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return computed === expectedSig;
}

Deno.serve(async (req) => {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature || !(await verifySignature(body, signature))) {
    return new Response("Invalid signature", { status: 400 });
  }

  const event = JSON.parse(body);
  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    (Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
  );

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const organizationId = session.metadata.organization_id;
      const planId = session.metadata.plan_id;
      const customerId = session.customer;
      const subscriptionId = session.subscription;

      // Update subscription: set plan, tier, and Stripe IDs
      await adminClient
        .schema("billing")
        .from("subscriptions")
        .update({
          plan_id: planId,
          tier_id: planId, // tier_id matches plan_id in our schema
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
        })
        .eq("organization_id", organizationId);

      console.log(`[stripe-webhook] checkout.session.completed: org=${organizationId} plan=${planId}`);
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const priceId = subscription.items.data[0]?.price?.id;
      const mapping = PRICE_TO_PLAN[priceId];

      if (mapping && subscription.status === "active") {
        await adminClient
          .schema("billing")
          .from("subscriptions")
          .update({
            plan_id: mapping.plan_id,
            tier_id: mapping.tier_id,
          })
          .eq("stripe_subscription_id", subscription.id);

        console.log(`[stripe-webhook] subscription.updated: ${subscription.id} → ${mapping.plan_id}`);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;

      // Downgrade to free
      await adminClient
        .schema("billing")
        .from("subscriptions")
        .update({
          plan_id: "free",
          tier_id: "free",
          stripe_subscription_id: null,
        })
        .eq("stripe_subscription_id", subscription.id);

      console.log(`[stripe-webhook] subscription.deleted: ${subscription.id} → free`);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      console.error(`[stripe-webhook] payment_failed: customer=${invoice.customer} amount=${invoice.amount_due}`);
      break;
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
