-- Add premium / Stripe subscription columns to profiles

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_premium          BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_customer_id  TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT,
  ADD COLUMN IF NOT EXISTS premium_since       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Constraint on subscription_status (idempotent)
DO $$ BEGIN
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_subscription_status_check
    CHECK (subscription_status IN ('active', 'canceled', 'past_due'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Fast lookup from Stripe webhook (customer ID → user ID)
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer
  ON public.profiles (stripe_customer_id);

-- Replace the permissive update policy with one that prevents users
-- from self-elevating their premium status or faking a Stripe customer ID.
-- The stripe-webhook Edge Function uses the service role key, which bypasses
-- RLS entirely, so it can still write is_premium / stripe_customer_id.
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;

CREATE POLICY "profiles_update"
  ON public.profiles
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND is_premium IS NOT DISTINCT FROM (SELECT is_premium          FROM public.profiles WHERE id = auth.uid())
    AND stripe_customer_id IS NOT DISTINCT FROM (SELECT stripe_customer_id FROM public.profiles WHERE id = auth.uid())
  );
