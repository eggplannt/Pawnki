import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Cancel Stripe subscription if one exists.
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (stripeKey) {
    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    if (profile?.stripe_customer_id) {
      try {
        const subsRes = await fetch(
          `https://api.stripe.com/v1/subscriptions?customer=${profile.stripe_customer_id}&status=active&limit=10`,
          { headers: { Authorization: `Bearer ${stripeKey}` } },
        );
        const subs = await subsRes.json();
        await Promise.all(
          (subs.data ?? []).map((sub: any) =>
            fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${stripeKey}` },
            })
          ),
        );
      } catch {
        // Non-fatal — proceed with account deletion even if Stripe cancel fails.
      }
    }
  }

  // Delete the account (cascades to all app data via ON DELETE CASCADE).
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    return new Response(error.message, { status: 500, headers: corsHeaders });
  }

  return new Response(JSON.stringify({ deleted: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
