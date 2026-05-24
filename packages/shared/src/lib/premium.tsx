import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getDb } from './db';

// ── Configuration ────────────────────────────────────────────────────────────
// Call configurePremium({ selfHosted: true/false }) in your app entry point
// before rendering. Web: read VITE_SELF_HOSTED. Expo: read EXPO_PUBLIC_SELF_HOSTED.

let _selfHosted = false;

export function configurePremium(opts: { selfHosted: boolean }): void {
  _selfHosted = opts.selfHosted;
}

export function isSelfHosted(): boolean {
  return _selfHosted;
}

// ── Context ──────────────────────────────────────────────────────────────────

interface PremiumContextValue {
  isPremium: boolean;
  loading: boolean;
  refetch: () => void;
}

const PremiumContext = createContext<PremiumContextValue>({
  isPremium: false,
  loading: true,
  refetch: () => {},
});

// ── Provider ─────────────────────────────────────────────────────────────────

export function PremiumProvider({ children }: { children: ReactNode }) {
  const [isPremium, setIsPremium] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const db = getDb();

    async function fetchProfile() {
      try {
        const { data: authData } = await db.auth.getUser();
        if (!authData.user) {
          setIsPremium(false);
          setLoading(false);
          return;
        }
        // is_premium is a new column — use any-cast until types are regenerated.
        const { data } = await (db as any)
          .from('profiles')
          .select('is_premium')
          .single();
        setIsPremium(data?.is_premium ?? false);
      } catch {
        setIsPremium(false);
      } finally {
        setLoading(false);
      }
    }

    fetchProfile();

    const { data: { subscription } } = db.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        setLoading(true);
        fetchProfile();
      }
      if (event === 'SIGNED_OUT') {
        setIsPremium(false);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  function refetch() {
    setLoading(true);
    setTick((t) => t + 1);
  }

  return (
    <PremiumContext.Provider value={{ isPremium, loading, refetch }}>
      {children}
    </PremiumContext.Provider>
  );
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function usePremium(): PremiumContextValue {
  return useContext(PremiumContext);
}

/** Returns true when the current user should see ads.
 *  False if: self-hosted, premium, or premium status still loading. */
export function useShowAds(): boolean {
  const { isPremium, loading } = usePremium();
  if (_selfHosted || loading || isPremium) return false;
  return true;
}
