import { AppShell } from '@/components/AppShell';
import { useAuth } from '@/hooks/useAuth';
import { useColorTheme, type ThemePref, type BoardPaletteKey } from '@/hooks/useColorTheme';
import { useReviewOrder, type ReviewOrder } from '@/hooks/useReviewOrder';
import { boardPalettes, BOARD_PALETTE_KEYS } from '@pawntree/shared';

const THEME_OPTIONS: { value: ThemePref; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: '⊙' },
  { value: 'light',  label: 'Light',  icon: '☀' },
  { value: 'dark',   label: 'Dark',   icon: '☾' },
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

  return (
    <AppShell>
      <div className="p-8 max-w-lg">
        <h1 className="text-content-primary text-2xl font-semibold mb-2">Settings</h1>
        {user && (
          <p className="text-content-secondary text-sm mb-8">{user.email}</p>
        )}

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
                <span>{opt.icon}</span>
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
                  <div className={`text-sm font-medium ${selected ? 'text-accent' : 'text-content-primary'}`}>
                    {opt.label}
                  </div>
                  <div className="text-content-muted text-xs mt-0.5">{opt.desc}</div>
                </button>
              );
            })}
          </div>
        </section>

        <button
          onClick={signOut}
          className="text-sm text-content-secondary hover:text-content-primary border border-border rounded-lg px-4 py-2 transition-colors"
        >
          Sign out
        </button>
      </div>
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
