import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Icon from '@mdi/react';
import { mdiThemeLightDark, mdiWeatherSunny, mdiWeatherNight, mdiStar, mdiStarOutline, mdiCheck } from '@mdi/js';
import { AppShell } from '@/components/AppShell';
import { FreePlayBoard } from '@/components/FreePlayBoard';
import { useDesktop } from '@/hooks/useDesktop';
import { useAuth } from '@/hooks/useAuth';
import { useColorTheme, type ThemePref, type BoardPaletteKey } from '@/hooks/useColorTheme';
import { useReviewOrder, type ReviewOrder } from '@/hooks/useReviewOrder';
import { boardPalettes, BOARD_PALETTE_KEYS, deleteMyAccount, usePremium } from '@pawnki/shared';
import { supabase } from '@/lib/supabase';

const THEME_OPTIONS: { value: ThemePref; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: mdiThemeLightDark },
  { value: 'light',  label: 'Light',  icon: mdiWeatherSunny },
  { value: 'dark',   label: 'Dark',   icon: mdiWeatherNight },
];

type PriceKey = 'annual' | 'monthly';

const PRICES: Record<PriceKey, { id: string; label: string; amount: string; sub: string }> = {
  monthly: { id: import.meta.env.VITE_STRIPE_PRICE_MONTHLY as string, label: 'Monthly', amount: '$4/mo',  sub: '' },
  annual:  { id: import.meta.env.VITE_STRIPE_PRICE_ANNUAL  as string, label: 'Annual',  amount: '$30/yr', sub: 'Save 38%' },
};

const PREMIUM_BENEFITS = [
  'Zero ads — ever',
  'Support independent chess tooling',
];

const REVIEW_ORDER_OPTIONS: { value: ReviewOrder; label: string; desc: string }[] = [
  { value: 'due-first',  label: 'Due first',  desc: 'Oldest due positions first (classic spaced-repetition).' },
  { value: 'interleave', label: 'Interleave', desc: "Round-robin across openings so you don't streak one." },
  { value: 'random',     label: 'Random',     desc: 'Fully shuffled.' },
];

export default function Settings() {
  const { user, signOut } = useAuth();
  const { pref, setPref, boardPref, setBoardPref } = useColorTheme();
  const [reviewOrder, setReviewOrder] = useReviewOrder();
  const isDesktop = useDesktop();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { isPremium, loading: premiumLoading, refetch: refetchPremium } = usePremium();
  const [selectedPrice, setSelectedPrice] = useState<PriceKey>('monthly');
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const justUpgraded = searchParams.get('upgraded') === '1';
  const checkoutSessionId = searchParams.get('session_id');

  useEffect(() => {
    if (!justUpgraded) return;
    setSearchParams({}, { replace: true });
    if (checkoutSessionId) {
      supabase.functions.invoke('verify-checkout', { body: { sessionId: checkoutSessionId } })
        .then(({ error }) => {
          if (error) setStripeError(`Upgrade verification failed: ${error.message}`);
          refetchPremium();
        });
    } else {
      refetchPremium();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justUpgraded]);

  async function handleSubscribe() {
    setStripeLoading(true);
    setStripeError(null);
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: { priceId: PRICES[selectedPrice].id },
      });
      if (error) throw error;
      window.location.href = data.url;
    } catch (e: any) {
      setStripeError(e?.message ?? 'Could not start checkout. Try again.');
      setStripeLoading(false);
    }
  }

  async function handleManage() {
    setStripeLoading(true);
    setStripeError(null);
    try {
      const { data, error } = await supabase.functions.invoke('create-portal-session', {});
      if (error) throw error;
      window.location.href = data.url;
    } catch (e: any) {
      setStripeError(e?.message ?? 'Could not open billing portal. Try again.');
      setStripeLoading(false);
    }
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteMyAccount();
      await signOut();
    } catch (e: any) {
      setDeleteError(e?.message ?? 'Could not delete account. Try again.');
      setDeleting(false);
    }
  }

  const settingsForm = (
    <>
      <h1 className="text-content-primary text-2xl font-semibold mb-2">Settings</h1>
      {user && <p className="text-content-secondary text-sm mb-8">{user.email}</p>}

      {/* ── Premium ─────────────────────────────────────────────── */}
      <section id="premium" className="mb-8">
        <h2 className="text-content-muted text-xs font-medium uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Icon path={mdiStarOutline} size={0.75} />
          Premium
        </h2>

        {premiumLoading ? (
          <div className="h-24 rounded-xl bg-bg-surface border border-border animate-pulse" />
        ) : isPremium ? (
          <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
            <div className="flex items-center gap-2 mb-1">
              <Icon path={mdiStar} size={0.85} className="text-accent" />
              <span className="text-content-primary font-medium text-sm">You're on Premium — thank you!</span>
            </div>
            <p className="text-content-muted text-xs mb-3">All ads are removed. You can manage or cancel your subscription at any time.</p>
            {stripeError && <p className="text-danger text-xs mb-2">{stripeError}</p>}
            <button
              onClick={handleManage}
              disabled={stripeLoading}
              className="text-sm text-content-secondary border border-border rounded-lg px-4 py-2 hover:bg-bg-surface transition-colors disabled:opacity-50"
            >
              {stripeLoading ? 'Loading…' : 'Manage subscription'}
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-bg-surface p-4">
            {justUpgraded && (
              <p className="text-accent text-sm mb-3 flex items-center gap-1.5">
                <Icon path={mdiCheck} size={0.75} />
                Subscription active — ads removed!
              </p>
            )}
            <ul className="mb-4 flex flex-col gap-1.5">
              {PREMIUM_BENEFITS.map((b) => (
                <li key={b} className="flex items-center gap-2 text-content-secondary text-sm">
                  <Icon path={mdiCheck} size={0.65} className="text-accent flex-shrink-0" />
                  {b}
                </li>
              ))}
            </ul>
            <div className="flex gap-2 mb-4">
              {(Object.entries(PRICES) as [PriceKey, typeof PRICES[PriceKey]][]).map(([key, price]) => (
                <button
                  key={key}
                  onClick={() => setSelectedPrice(key)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                    selectedPrice === key ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/40'
                  }`}
                >
                  <div className={`text-sm font-medium ${selectedPrice === key ? 'text-accent' : 'text-content-primary'}`}>{price.label}</div>
                  <div className="text-content-muted text-xs">{price.amount}</div>
                  {price.sub && <div className="text-accent text-xs font-medium">{price.sub}</div>}
                </button>
              ))}
            </div>
            {stripeError && <p className="text-danger text-xs mb-2">{stripeError}</p>}
            <button
              onClick={handleSubscribe}
              disabled={stripeLoading}
              className="w-full py-2.5 rounded-lg bg-accent text-bg-base font-medium text-sm hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {stripeLoading ? 'Redirecting…' : `Subscribe — ${PRICES[selectedPrice].amount}`}
            </button>
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-content-muted text-xs font-medium uppercase tracking-wider mb-3">Appearance</h2>
        <div className="flex rounded-xl overflow-hidden border border-border bg-bg-surface p-1 gap-1">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPref(opt.value)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                pref === opt.value
                  ? 'bg-accent/15 text-accent'
                  : 'text-content-muted hover:text-content-secondary'
              }`}
            >
              <Icon path={opt.icon} size={0.85} />
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-content-muted text-xs font-medium uppercase tracking-wider mb-3">Board theme</h2>
        <div className="grid grid-cols-3 gap-2">
          {BOARD_PALETTE_KEYS.map((key) => {
            const p = boardPalettes[key];
            const selected = boardPref === key;
            return (
              <button
                key={key}
                onClick={() => setBoardPref(key as BoardPaletteKey)}
                className={`rounded-xl border p-2 transition-colors ${
                  selected ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/40'
                }`}
              >
                <BoardPreview dark={p.dark} light={p.light} />
                <div className={`text-sm font-medium mt-2 ${selected ? 'text-accent' : 'text-content-primary'}`}>
                  {p.label}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-content-muted text-xs font-medium uppercase tracking-wider mb-3">Review order</h2>
        <div className="flex flex-col gap-2">
          {REVIEW_ORDER_OPTIONS.map((opt) => {
            const selected = reviewOrder === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setReviewOrder(opt.value)}
                className={`text-left rounded-xl border px-3 py-2 transition-colors ${
                  selected ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/40'
                }`}
              >
                <div className={`text-sm font-medium ${selected ? 'text-accent' : 'text-content-primary'}`}>{opt.label}</div>
                <div className="text-content-muted text-xs mt-0.5">{opt.desc}</div>
              </button>
            );
          })}
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={signOut}
          className="text-sm text-content-secondary hover:text-content-primary border border-border rounded-lg px-4 py-2 transition-colors"
        >
          Sign out
        </button>
      </div>

      <section className="mt-12 pt-6 border-t border-danger/20">
        <h2 className="text-danger text-xs font-medium uppercase tracking-wider mb-2">Danger zone</h2>
        <p className="text-content-muted text-sm mb-3">
          Permanently delete your account, every opening, and all review history. This can't be undone.
        </p>
        <button
          onClick={() => { setConfirmDelete(true); setDeleteConfirmText(''); setDeleteError(null); }}
          className="text-sm text-danger border border-danger/40 rounded-lg px-4 py-2 hover:bg-danger/10 transition-colors"
        >
          Delete account
        </button>
      </section>
    </>
  );

  return (
    <AppShell>
      {/* Mobile */}
      <div className="p-8 max-w-lg lg:hidden">
        {settingsForm}
      </div>

      {/* Desktop: board center, settings right */}
      <div className="hidden lg:flex flex-1 h-full overflow-hidden">
        <div className="flex-1 flex items-center justify-center p-6 overflow-hidden">
          {isDesktop && <FreePlayBoard />}
        </div>
        <div className="w-[420px] flex-none border-l border-border overflow-auto p-8">
          {settingsForm}
        </div>
      </div>

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => !deleting && setConfirmDelete(false)}
        >
          <div
            className="bg-bg-elevated border border-danger/40 rounded-xl p-6 max-w-md mx-4 w-full shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-content-primary font-semibold mb-2">Delete account?</h3>
            <p className="text-content-secondary text-sm mb-3">
              This permanently removes your account and every opening, tree, review, and streak. There is no recovery.
            </p>
            <p className="text-content-muted text-sm mb-2">
              Type <span className="font-mono text-content-primary">delete</span> to confirm.
            </p>
            <input
              type="text"
              autoFocus
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              disabled={deleting}
              className="w-full bg-bg-surface border border-border rounded-lg px-3 py-2 text-content-primary text-sm font-mono outline-none focus:border-danger/40 transition-colors disabled:opacity-50"
            />
            {deleteError && <p className="text-danger text-xs mt-2">{deleteError}</p>}
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="flex-1 py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleting || deleteConfirmText !== 'delete'}
                className="flex-1 py-2 rounded-lg bg-danger text-bg-base font-medium text-sm hover:bg-danger/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deleting ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function BoardPreview({ dark, light }: { dark: string; light: string }) {
  const sq = (i: number, j: number) => ((i + j) % 2 === 0 ? light : dark);
  return (
    <div
      className="w-full aspect-square rounded-md overflow-hidden grid"
      style={{ gridTemplateColumns: 'repeat(4, 1fr)', gridTemplateRows: 'repeat(4, 1fr)' }}
    >
      {Array.from({ length: 4 }).flatMap((_, i) =>
        Array.from({ length: 4 }).map((__, j) => (
          <div key={`${i}-${j}`} style={{ backgroundColor: sq(i, j) }} />
        )),
      )}
    </div>
  );
}
