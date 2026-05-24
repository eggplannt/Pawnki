import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

async function getUserIdByCustomer(customerId: string): Promise<string | null> {
  const { data } = await admin
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();
  return data?.id ?? null;
}

serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  const body = await req.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!,
    );
  } catch (err: any) {
    return new Response(`Webhook error: ${err.message}`, { status: 400 });
  }

  const now = new Date().toISOString();

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = await getUserIdByCustomer(sub.customer as string);
      if (!userId) break;
      const isActive = sub.status === 'active';
      await admin.from('profiles').update({
        is_premium: isActive,
        subscription_status: sub.status,
        premium_since: isActive ? now : null,
        updated_at: now,
      }).eq('id', userId);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = await getUserIdByCustomer(sub.customer as string);
      if (!userId) break;
      await admin.from('profiles').update({
        is_premium: false,
        subscription_status: 'canceled',
        updated_at: now,
      }).eq('id', userId);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const userId = await getUserIdByCustomer(invoice.customer as string);
      if (!userId) break;
      // Keep is_premium = true; Stripe will retry. Mark as past_due so the UI
      // can surface a "payment problem" warning if desired.
      await admin.from('profiles').update({
        subscription_status: 'past_due',
        updated_at: now,
      }).eq('id', userId);
      break;
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
