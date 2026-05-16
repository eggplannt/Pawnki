import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { listOpenings, deleteOpening } from '@/lib/openings';
import type { Opening } from '@/types';

type Tab = 'white' | 'black';
type OpeningWithStats = Opening & { nodeCount: number; dueCount: number };

export default function Library() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('color') === 'black' ? 'black' : 'white';
  const [tab, setTabState] = useState<Tab>(initialTab);

  function setTab(t: Tab) {
    setTabState(t);
    setSearchParams(t === 'white' ? {} : { color: t }, { replace: true });
  }
  const [openings, setOpenings] = useState<OpeningWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    loadOpenings();
  }, []);

  async function loadOpenings() {
    setLoading(true);
    try {
      const data = await listOpenings();
      setOpenings(data);
    } finally {
      setLoading(false);
    }
  }

  const filtered = openings.filter((o) => o.color === tab);

  return (
    <AppShell>
      <div className="flex-1 p-6 lg:p-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-content-primary text-2xl font-semibold">Library</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-bg-base font-medium text-sm px-4 py-2.5 rounded-xl transition-colors shadow-sm shadow-accent/20"
          >
            <span className="text-lg leading-none">+</span>
            New Opening
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-bg-surface rounded-xl p-1 mb-6 w-fit border border-border-subtle">
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
              {t === 'white' ? '♔ White' : '♚ Black'}
            </button>
          ))}
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <span className="text-5xl mb-4 block opacity-30">
              {tab === 'white' ? '♔' : '♚'}
            </span>
            <p className="text-content-muted text-lg mb-2">No {tab} openings yet</p>
            <p className="text-content-muted text-sm">
              Create one to start building your repertoire.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((opening) => (
              <OpeningCard key={opening.id} opening={opening} onDeleted={loadOpenings} />
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateOpeningModal
          defaultColor={tab}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            loadOpenings();
          }}
        />
      )}
    </AppShell>
  );
}

function OpeningCard({ opening, onDeleted }: { opening: OpeningWithStats; onDeleted: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const isWhite = opening.color === 'white';

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  async function handleDelete() {
    setMenuOpen(false);
    if (!confirm(`Delete "${opening.name}"? This cannot be undone.`)) return;
    await deleteOpening(opening.id);
    onDeleted();
  }

  return (
    <div className="relative bg-bg-surface border border-border rounded-xl hover:border-accent/40 transition-all group hover:shadow-md hover:shadow-black/10">
      {/* Color stripe at top */}
      <div className={`h-1 rounded-t-xl ${isWhite ? 'bg-gold' : 'bg-accent'}`} />

      <Link to={`/library/${opening.id}`} className="block p-4">
        <div className="flex items-start justify-between mb-3 pr-6">
          <div className="flex items-center gap-2">
            <span className={`text-lg ${isWhite ? 'text-gold' : 'text-accent'}`}>
              {isWhite ? '♔' : '♚'}
            </span>
            <h3 className="text-content-primary font-medium group-hover:text-accent transition-colors">
              {opening.name}
            </h3>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-content-muted text-xs bg-bg-elevated px-2 py-1 rounded-md">
            {Math.max(0, opening.nodeCount - 1)} moves
          </span>
          {opening.dueCount > 0 && (
            <span className="bg-gold/15 text-gold text-xs font-medium px-2 py-1 rounded-md">
              {opening.dueCount} due
            </span>
          )}
        </div>
      </Link>

      {/* Three-dot menu */}
      <div ref={menuRef} className="absolute top-4 right-3">
        <button
          onClick={(e) => { e.preventDefault(); setMenuOpen(!menuOpen); }}
          className="w-7 h-7 flex items-center justify-center rounded-md text-content-muted hover:text-content-primary hover:bg-bg-elevated transition-colors"
        >
          ···
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-8 bg-bg-elevated border border-border rounded-xl shadow-lg py-1 z-10 min-w-[120px]">
            <button
              onClick={() => { setMenuOpen(false); navigate(`/library/${opening.id}`); }}
              className="w-full text-left px-3 py-2 text-sm text-content-primary hover:bg-bg-surface transition-colors"
            >
              Open
            </button>
            <button
              onClick={handleDelete}
              className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-bg-surface transition-colors"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Create Opening Modal ────────────────────────────────────────────────────

import { createOpening, type ImportProgress } from '@/lib/openings';

function CreateOpeningModal({
  defaultColor,
  onClose,
  onCreated,
}: {
  defaultColor: Tab;
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
    if (!name.trim()) return;
    setSaving(true);
    setProgress(null);
    setError(null);
    try {
      await createOpening(name.trim(), color, pgn.trim() || null, setProgress);
      onCreated();
    } catch (err: any) {
      setError(err.message ?? 'Failed to create opening');
      setSaving(false);
      setProgress(null);
    }
  }

  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={saving ? undefined : onClose}>
      <div
        className="bg-bg-surface border border-border rounded-2xl w-full max-w-md mx-4 overflow-hidden shadow-xl shadow-black/30"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header stripe */}
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
                  <div
                    className="bg-accent h-full rounded-full transition-[width] duration-150"
                    style={{ width: `${progressPct}%` }}
                  />
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
              {/* Name */}
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

              {/* Color */}
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
                      {c === 'white' ? '♔ White' : '♚ Black'}
                    </button>
                  ))}
                </div>
              </div>

              {/* PGN */}
              <div>
                <label className="block text-content-secondary text-sm mb-1">
                  PGN <span className="text-content-muted">(optional — import moves)</span>
                </label>
                <textarea
                  value={pgn}
                  onChange={(e) => setPgn(e.target.value)}
                  placeholder={"Paste one or multiple games.\nShared opening moves are auto-merged."}
                  rows={5}
                  className="w-full bg-bg-elevated border border-border rounded-xl px-3 py-2.5 text-content-primary text-sm placeholder:text-content-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 resize-none font-mono"
                />
              </div>

              {error && <p className="text-danger text-sm">{error}</p>}

              {/* Actions */}
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
