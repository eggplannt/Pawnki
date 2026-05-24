import { createContext, useCallback, useContext, useEffect, useState } from 'react';
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

    async function fetchProfile(userId: string) {
      try {
        const { data } = await (db as any)
          .from('profiles')
          .select('is_premium')
          .eq('id', userId)
          .single();
        setIsPremium(data?.is_premium ?? false);
      } catch {
        setIsPremium(false);
      } finally {
        setLoading(false);
      }
    }

    const { data: { subscription } } = db.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setLoading(true);
        fetchProfile(session.user.id);
      } else {
        setIsPremium(false);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const refetch = useCallback(() => {
    setLoading(true);
    setTick((t) => t + 1);
  }, []);

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
