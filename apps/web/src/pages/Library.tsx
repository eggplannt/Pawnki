import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Icon from '@mdi/react';
import { mdiChessKing, mdiDelete } from '@mdi/js';
import { AppShell } from '@/components/AppShell';
import { FreePlayBoard } from '@/components/FreePlayBoard';
import { useDesktop } from '@/hooks/useDesktop';
import { listOpenings, deleteOpening, getLearnableCountsByOpening, getLearnedCountsByOpening, type Opening } from '@pawnki/shared';

type Tab = 'white' | 'black';
type OpeningWithStats = Opening & {
  nodeCount: number;
  learnedCount: number;
  learnableCount: number;
};

export default function Library() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('color') === 'black' ? 'black' : 'white';
  const [tab, setTabState] = useState<Tab>(initialTab);
  const isDesktop = useDesktop();
  const [openings, setOpenings] = useState<OpeningWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  function setTab(t: Tab) {
    setTabState(t);
    setSearchParams(t === 'white' ? {} : { color: t }, { replace: true });
  }

  useEffect(() => { loadOpenings(); }, []);

  async function fetchOpenings() {
    const [data, learnedCounts, learnableCounts] = await Promise.all([
      listOpenings(),
      getLearnedCountsByOpening().catch(() => new Map<string, number>()),
      getLearnableCountsByOpening().catch(() => new Map<string, number>()),
    ]);
    setOpenings(
      data.map((o) => ({
        ...o,
        learnedCount: learnedCounts.get(o.id) ?? 0,
        learnableCount: learnableCounts.get(o.id) ?? 0,
      })),
    );
  }

  async function loadOpenings() {
    setLoading(true);
    try { await fetchOpenings(); }
    finally { setLoading(false); }
  }

  const filtered = openings.filter((o) => o.color === tab);

  return (
    <AppShell>
      {/* ── Mobile layout ──────────────────────────────────────────── */}
      <div className="flex-1 p-6 lg:hidden">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-content-primary text-2xl font-semibold">Library</h1>
          <div className="flex items-center gap-2">
            <RefreshButton loading={loading} onRefresh={loadOpenings} />
            <NewOpeningButton onClick={() => { setShowCreate(true); fetchOpenings(); }} />
          </div>
        </div>
        <ColorTabs tab={tab} setTab={setTab} />
        <OpeningList loading={loading} filtered={filtered} tab={tab} onDeleted={loadOpenings} />
      </div>

      {/* ── Desktop layout: board center, content right ────────────── */}
      <div className="hidden lg:flex flex-1 h-full overflow-hidden">
        {/* Center: board */}
        <div className="flex-1 flex items-center justify-center p-6 overflow-hidden">
          {isDesktop && <FreePlayBoard />}
        </div>

        {/* Right panel: color tabs + opening list */}
        <div className="w-80 flex-none flex flex-col border-l border-border overflow-hidden">
          <div className="p-5 pb-3 shrink-0 border-b border-border-subtle">
            <div className="flex items-center justify-between mb-3">
              <h1 className="text-content-primary text-lg font-semibold">Library</h1>
              <div className="flex items-center gap-1.5">
                <RefreshButton loading={loading} onRefresh={loadOpenings} />
                <NewOpeningButton onClick={() => { setShowCreate(true); fetchOpenings(); }} />
              </div>
            </div>
            <ColorTabs tab={tab} setTab={setTab} />
          </div>
          <div className="flex-1 overflow-auto p-4">
            <OpeningList loading={loading} filtered={filtered} tab={tab} onDeleted={loadOpenings} />
          </div>
        </div>
      </div>

      {showCreate && (
        <CreateOpeningModal
          defaultColor={tab}
          existingOpenings={openings}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadOpenings(); }}
        />
      )}
    </AppShell>
  );
}

// ── Shared sub-components ───────────────────────────────────────────────────

function RefreshButton({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return (
    <button
      onClick={onRefresh}
      disabled={loading}
      title="Refresh"
      className="w-9 h-9 flex items-center justify-center rounded-xl border border-border text-content-muted hover:text-content-primary hover:border-accent/40 transition-colors disabled:opacity-40"
    >
      <span className={loading ? 'animate-spin inline-block' : ''}>↻</span>
    </button>
  );
}

function NewOpeningButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-bg-base font-medium text-sm px-4 py-2.5 rounded-xl transition-colors shadow-sm shadow-accent/20"
    >
      <span className="text-lg leading-none">+</span>
      <span className="hidden sm:inline">New Opening</span>
    </button>
  );
}

function ColorTabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div className="flex gap-1 bg-bg-surface rounded-xl p-1 mb-4 w-fit border border-border-subtle">
      {(['white', 'black'] as const).map((t) => (
        <button
          key={t}
          onClick={() => setTab(t)}
          className={[
            'px-5 py-2 rounded-lg text-sm font-medium transition-all capitalize',
            tab === t
              ? t === 'white'
                ? 'bg-gold/15 text-gold shadow-sm'
                : 'bg-accent/15 text-accent shadow-sm'
              : 'text-content-muted hover:text-content-secondary',
          ].join(' ')}
        >
          <span className="inline-flex items-center gap-1.5">
            <Icon path={mdiChessKing} size={0.7} color={`rgb(var(--color-${t === 'white' ? 'gold' : 'accent'}))`} />
            {t === 'white' ? 'White' : 'Black'}
          </span>
        </button>
      ))}
    </div>
  );
}

function OpeningList({ loading, filtered, tab, onDeleted }: {
  loading: boolean;
  filtered: OpeningWithStats[];
  tab: Tab;
  onDeleted: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (filtered.length === 0) {
    return (
      <div className="text-center py-20">
        <div className="mb-4 flex justify-center opacity-30">
          <Icon path={mdiChessKing} size={2.5} color={`rgb(var(--color-${tab === 'white' ? 'gold' : 'accent'}))`} />
        </div>
        <p className="text-content-muted text-lg mb-2">No {tab} openings yet</p>
        <p className="text-content-muted text-sm">Create one to start building your repertoire.</p>
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
      {filtered.map((opening) => (
        <OpeningCard key={opening.id} opening={opening} onDeleted={onDeleted} />
      ))}
    </div>
  );
}

function OpeningCard({ opening, onDeleted }: { opening: OpeningWithStats; onDeleted: () => void }) {
  const isWhite = opening.color === 'white';

  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    if (!confirm(`Delete "${opening.name}"? This cannot be undone.`)) return;
    await deleteOpening(opening.id);
    onDeleted();
  }

  return (
    <div className="relative bg-bg-surface border border-border rounded-xl hover:border-accent/40 transition-all group hover:shadow-md hover:shadow-black/10">
      <div className={`h-1 rounded-t-xl ${isWhite ? 'bg-gold' : 'bg-accent'}`} />
      <Link to={`/library/${opening.id}`} className="block p-4">
        <div className="flex items-start justify-between mb-3 pr-8">
          <div className="flex items-center gap-2">
            <Icon path={mdiChessKing} size={0.85} color={`rgb(var(--color-${isWhite ? 'gold' : 'accent'}))`} />
            <h3 className="text-content-primary font-medium group-hover:text-accent transition-colors">
              {opening.name}
            </h3>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-content-muted text-xs bg-bg-elevated px-2 py-1 rounded-md">
            {opening.learnedCount} Position{opening.learnedCount !== 1 ? 's' : ''} in repertoire
          </span>
          {opening.learnableCount === 0 ? (
            <span className="bg-bg-elevated text-content-muted text-xs px-2 py-1 rounded-md italic">
              Nothing studiable
            </span>
          ) : opening.learnedCount >= opening.learnableCount ? null : (
            <span className="bg-accent/15 text-accent text-xs font-medium px-2 py-1 rounded-md">
              {opening.learnableCount - opening.learnedCount} Position{opening.learnableCount - opening.learnedCount !== 1 ? 's' : ''} to learn
            </span>
          )}
        </div>
      </Link>
      <button
        onClick={handleDelete}
        title="Delete opening"
        className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-md text-content-muted hover:text-danger hover:bg-danger/10 transition-all opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
      >
        <Icon path={mdiDelete} size={0.6} />
      </button>
    </div>
  );
}

// ── Create Opening Modal ────────────────────────────────────────────────────

import { createOpening, type ImportProgress } from '@pawnki/shared';

function CreateOpeningModal({
  defaultColor,
  existingOpenings,
  onClose,
  onCreated,
}: {
  defaultColor: Tab;
  existingOpenings: OpeningWithStats[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<'white' | 'black'>(defaultColor);
  const [pgn, setPgn] = useState('');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const duplicate = existingOpenings.find((o) => o.name === trimmed && o.color === color);
    if (duplicate) {
      setError(`You already have a ${color} opening named "${trimmed}".`);
      return;
    }
    setSaving(true);
    setProgress(null);
    setError(null);
    try {
      await createOpening(trimmed, color, pgn.trim() || null, setProgress);
      onCreated();
    } catch (err: any) {
      setError(err.message ?? 'Failed to create opening');
      setSaving(false);
      setProgress(null);
    }
  }

  const progressPct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={saving ? undefined : onClose}>
      <div
        className="bg-bg-surface border border-border rounded-2xl w-full max-w-md mx-4 overflow-hidden shadow-xl shadow-black/30"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-1 px-6 pt-6 mb-4">
          <div className="h-1 flex-1 rounded-full bg-accent" />
          <div className="h-1 flex-1 rounded-full bg-gold" />
          <div className="h-1 flex-1 rounded-full bg-accent-dim" />
        </div>
        <div className="px-6 pb-6">
          <h2 className="text-content-primary text-lg font-semibold mb-4">New Opening</h2>
          {saving ? (
            <div className="py-4 flex flex-col gap-3">
              <p className="text-content-secondary text-sm text-center">
                {progress?.phase === 'parsing'
                  ? 'Parsing PGN...'
                  : progress
                    ? `Importing moves... ${progress.current} / ${progress.total}`
                    : 'Creating...'}
              </p>
              {progress?.phase === 'importing' && progress.total > 0 && (
                <div className="w-full bg-bg-elevated rounded-full h-2 overflow-hidden">
                  <div className="bg-accent h-full rounded-full transition-[width] duration-150" style={{ width: `${progressPct}%` }} />
                </div>
              )}
              {progress?.phase === 'parsing' && (
                <div className="w-full bg-bg-elevated rounded-full h-2 overflow-hidden">
                  <div className="bg-gold h-full rounded-full w-full animate-pulse" />
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label className="block text-content-secondary text-sm mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Sicilian Najdorf"
                  className="w-full bg-bg-elevated border border-border rounded-xl px-3 py-2.5 text-content-primary text-sm placeholder:text-content-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-content-secondary text-sm mb-1">Color</label>
                <div className="flex gap-2">
                  {(['white', 'black'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      className={[
                        'flex-1 py-2.5 rounded-xl text-sm font-medium border transition-all capitalize',
                        color === c
                          ? c === 'white'
                            ? 'border-gold text-gold bg-gold/10 shadow-sm shadow-gold/10'
                            : 'border-accent text-accent bg-accent/10 shadow-sm shadow-accent/10'
                          : 'border-border text-content-muted hover:text-content-secondary',
                      ].join(' ')}
                    >
                      <span className="inline-flex items-center justify-center gap-1.5">
                        <Icon path={mdiChessKing} size={0.7} color={`rgb(var(--color-${c === 'white' ? 'gold' : 'accent'}))`} />
                        {c === 'white' ? 'White' : 'Black'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label className="block text-content-secondary text-sm">
                    PGN <span className="text-content-muted">(optional)</span>
                  </label>
                  <label className="text-xs text-accent hover:underline cursor-pointer">
                    Load file…
                    <input
                      type="file"
                      accept=".pgn,text/plain,application/x-chess-pgn"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        try { setPgn(await file.text()); }
                        finally { e.target.value = ''; }
                      }}
                    />
                  </label>
                </div>
                <textarea
                  value={pgn}
                  onChange={(e) => setPgn(e.target.value)}
                  placeholder={"Paste or load one or multiple games.\nShared opening moves are auto-merged."}
                  rows={5}
                  className="w-full bg-bg-elevated border border-border rounded-xl px-3 py-2.5 text-content-primary text-sm placeholder:text-content-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 resize-none font-mono"
                />
              </div>
              {error && <p className="text-danger text-sm">{error}</p>}
              <div className="flex gap-3 justify-end mt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 text-sm text-content-secondary hover:text-content-primary transition-colors rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!name.trim()}
                  className="px-5 py-2.5 bg-accent hover:bg-accent-hover text-bg-base text-sm font-medium rounded-xl transition-colors disabled:opacity-50 shadow-sm shadow-accent/20"
                >
                  Create
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
