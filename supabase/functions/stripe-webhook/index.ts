import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

async function verifyAndParse(body: string, signature: string, secret: string): Promise<any> {
  const parts: Record<string, string> = {};
  for (const chunk of signature.split(',')) {
    const eq = chunk.indexOf('=');
    if (eq !== -1) parts[chunk.slice(0, eq)] = chunk.slice(eq + 1);
  }
  const timestamp = parts['t'];
  const sig = parts['v1'];
  if (!timestamp || !sig) throw new Error('Invalid signature header');

  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    throw new Error('Timestamp too old');
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`));
  const computed = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (computed !== sig) throw new Error('Signature mismatch');

  return JSON.parse(body);
}

serve(async (req) => {
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!webhookSecret) {
    return new Response('STRIPE_WEBHOOK_SECRET not configured', { status: 500 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  const body = await req.text();
  let event: any;
  try {
    event = await verifyAndParse(body, signature, webhookSecret);
  } catch (err: any) {
    return new Response(`Webhook error: ${err.message}`, { status: 400 });
  }

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

  const now = new Date().toISOString();

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const userId = await getUserIdByCustomer(sub.customer);
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
      const sub = event.data.object;
      const userId = await getUserIdByCustomer(sub.customer);
      if (!userId) break;
      await admin.from('profiles').update({
        is_premium: false,
        subscription_status: 'canceled',
        updated_at: now,
      }).eq('id', userId);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const userId = await getUserIdByCustomer(invoice.customer);
      if (!userId) break;
      await admin.from('profiles').update({
        is_premium: false,
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
