import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { AppShell } from '@/components/AppShell';
import { getOpening, getNodes, buildTree } from '@/lib/openings';
import { getLearnedNodeIds, insertReviewCards } from '@/lib/review-cards';
import {
  startSession,
  attemptMove,
  opponentMove,
  showHint,
  finalize,
  applicableChildren,
  type PracticeSession,
  type PracticeMode,
  type SessionSummary,
} from '@/lib/practice';
import { useColorTheme } from '@/hooks/useColorTheme';
import type { Node, Opening } from '@/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function findNodeById(root: Node, id: string): Node | null {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const found = findNodeById(c, id);
    if (found) return found;
  }
  return null;
}

interface BoardErrorBoundaryProps { children: ReactNode; resetKey: string }
class BoardErrorBoundary extends Component<BoardErrorBoundaryProps, { errored: boolean }> {
  state = { errored: false };
  static getDerivedStateFromError() { return { errored: true }; }
  componentDidUpdate(prev: BoardErrorBoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.errored) this.setState({ errored: false });
  }
  render() {
    if (this.state.errored) return <div className="w-full h-full bg-bg-surface rounded-lg flex items-center justify-center text-content-muted">Board error</div>;
    return this.props.children;
  }
}

// ── Component ───────────────────────────────────────────────────────────────

const OPPONENT_DELAY_MS = 300;

export default function Practice() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { colors } = useColorTheme();

  const mode = (searchParams.get('mode') as PracticeMode) ?? 'learn';
  const fromNodeId = searchParams.get('from');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [banner, setBanner] = useState<{ text: string; kind: 'info' | 'warn' | 'err' } | null>(null);
  const [revealedSans, setRevealedSans] = useState<string[] | null>(null);
  const [hintSquares, setHintSquares] = useState<Record<string, React.CSSProperties>>({});
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [savingFinalize, setSavingFinalize] = useState(false);
  const [confirmEndEarly, setConfirmEndEarly] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Initial load ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setSummary(null);
    setSession(null);
    setBanner(null);
    setRevealedSans(null);
    setHintSquares({});
    setSavingFinalize(false);
    (async () => {
      try {
        const [op, nodes, learnedSet] = await Promise.all([
          getOpening(id),
          getNodes(id),
          getLearnedNodeIds(id),
        ]);
        if (cancelled) return;
        const tree = buildTree(nodes);
        if (!tree) { setError('Opening has no moves yet.'); setLoading(false); return; }
        const rootNode = fromNodeId ? findNodeById(tree, fromNodeId) ?? tree : tree;
        setOpening(op);
        const newSession = startSession({
          mode,
          userColor: op.color,
          rootNode,
          learnedNodeIds: learnedSet,
        });
        setSession(newSession);
        setLoading(false);
      } catch (e: any) {
        if (!cancelled) { setError(e?.message ?? 'Failed to start session'); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mode, fromNodeId, reloadKey]);

  // ── Banner helper ────────────────────────────────────────────────────────

  const showBanner = useCallback((text: string, kind: 'info' | 'warn' | 'err', timeout: number = 2500) => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ text, kind });
    bannerTimer.current = setTimeout(() => setBanner(null), timeout);
  }, []);

  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); }, []);

  // ── Opponent auto-play ───────────────────────────────────────────────────

  useEffect(() => {
    if (!session) return;
    if (session.status !== 'opponent-to-move') return;
    const t = setTimeout(() => {
      setSession((s) => {
        if (!s || s.status !== 'opponent-to-move') return s;
        const { session: next } = opponentMove(s);
        return next;
      });
    }, OPPONENT_DELAY_MS);
    return () => clearTimeout(t);
  }, [session?.status, session?.currentNode.id]);

  // ── Learn-mode auto-skip ─────────────────────────────────────────────────
  // "From beginning" doesn't mean replaying the entire opening — it means
  // learning what's left in this subtree. Auto-play user moves the user has
  // already learned (and forced branching choices).
  useEffect(() => {
    if (!session || session.status !== 'awaiting-user') return;
    if (session.options.mode !== 'learn') return;
    const applicable = applicableChildren(session);
    if (applicable.length !== 1) return;
    const target = applicable[0];
    const targetLearnable = session.learnableMap.get(target.id) ?? false;
    const isTeachingMove = targetLearnable && !session.options.learnedNodeIds.has(target.id);
    if (isTeachingMove) return;
    const san = target.move_san;
    if (!san) return;
    const t = setTimeout(() => {
      setSession((s) => {
        if (!s || s.status !== 'awaiting-user') return s;
        return attemptMove(s, san).session;
      });
    }, OPPONENT_DELAY_MS);
    return () => clearTimeout(t);
  }, [session?.status, session?.currentNode.id]);

  // ── Detect completion → finalize ─────────────────────────────────────────

  useEffect(() => {
    if (!session || session.status !== 'complete' || summary || savingFinalize) return;
    setSavingFinalize(true);
    const s = finalize(session);
    // Only insert review_cards for unlearned visited user-moves (Learn mode);
    // Practice mode never creates cards.
    const toInsert =
      session.options.mode === 'learn'
        ? s.visitedUserMoveIds.filter((nid) => !session.options.learnedNodeIds.has(nid))
        : [];
    (async () => {
      try {
        if (toInsert.length > 0) await insertReviewCards(toInsert);
      } catch (e: any) {
        showBanner(`Couldn't save progress: ${e?.message ?? e}`, 'err');
      } finally {
        setSummary(s);
        setSavingFinalize(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status]);

  // ── Hints reset on advance ───────────────────────────────────────────────

  useEffect(() => {
    setHintSquares({});
    setRevealedSans(null);
  }, [session?.currentNode.id]);

  // ── User move (drag) ─────────────────────────────────────────────────────

  const handlePieceDrop = useCallback(({ sourceSquare, targetSquare }: {
    piece: unknown; sourceSquare: string; targetSquare: string | null;
  }): boolean => {
    if (!session || !targetSquare || session.status !== 'awaiting-user') return false;
    const chess = new Chess(session.currentNode.fen);
    const result = chess.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
    if (!result) {
      showBanner("Invalid Move", 'err');
      return false;
    }
    const san = result.san;
    result.san
    const out = attemptMove(session, san );
    setSession(out.session);
    if (out.verdict === 'correct') {
      // If we're in learn mode and this came after a wrong attempt, the move
      // got queued for re-prompt — tell the user.
      if (mode === 'learn' && session.wrongAttemptsHere > 0) {
        showBanner('Correct — but you stumbled. We\'ll re-ask this at the end.', 'info');
      }
      else showBanner('Correct', 'info', 500);
    } else if (out.verdict === 'wrong') {
      setShakeKey((k) => k + 1);
      showBanner(out.reason ?? 'Wrong move.', 'err');
    } else if (out.verdict === 'wrong-disallowed') {
      showBanner(out.reason ?? 'Already practiced.', 'info');
    } else if (out.verdict === 'wrong-mode') {
      showBanner(out.reason ?? 'Not allowed in this mode.', 'warn');
    }
    return out.verdict === 'correct';
  }, [session, showBanner]);

  const canDragPiece = useCallback(({ piece }: { piece: { pieceType: string } }): boolean => {
    if (!session || session.status !== 'awaiting-user') return false;
    const userIsWhite = session.options.userColor === 'white';
    return userIsWhite === (piece.pieceType[0] === 'w');
  }, [session]);

  // ── Hint button ──────────────────────────────────────────────────────────

  const handleHint = useCallback(() => {
    if (!session || session.status !== 'awaiting-user') return;
    const nextLevel: 1 | 2 = session.hintLevel === 0 ? 1 : 2;
    const { session: next, hint } = showHint(session, nextLevel);
    setSession(next);
    if (nextLevel === 1) {
      const styles: Record<string, React.CSSProperties> = {};
      for (const sq of hint.fromSquares) {
        styles[sq] = { boxShadow: `inset 0 0 0 3px ${colors.accent.default}` };
      }
      setHintSquares(styles);
    } else if (nextLevel === 2 && hint.sans) {
      setRevealedSans(hint.sans);
    }
  }, [session, colors]);

  // ── End early ────────────────────────────────────────────────────────────
  // Stops the session immediately. The completion effect picks it up and
  // saves `firstTryCorrect` as review_cards — positions the user nailed on
  // their first attempt are marked learned; everything else is left untouched.

  const handleEndEarly = useCallback(() => {
    if (!session || session.status === 'complete') return;
    setConfirmEndEarly(true);
  }, [session]);

  const confirmEnd = useCallback(() => {
    setConfirmEndEarly(false);
    setSession((s) => (s ? { ...s, status: 'complete' } : s));
  }, []);

  const endEarlyStats = useMemo(() => {
    if (!session) return null;
    const learnedNow = Array.from(session.firstTryCorrect).filter(
      (nid) => !session.options.learnedNodeIds.has(nid),
    ).length;
    const remaining = Math.max(0, session.totalApplicable - session.completedApplicable);
    return { learnedNow, remaining };
  }, [session]);

  // ── Computed UI bits ─────────────────────────────────────────────────────

  const choiceCount = useMemo(() => {
    if (!session || session.status !== 'awaiting-user') return 0;
    return applicableChildren(session).length;
  }, [session]);

  // Danger arrows on children that are already done this session (or whose
  // subtree has nothing left applicable) — visually steer the user away.
  // We also stamp an "X" on the destination square via squareStyles.
  const doneArrows = useMemo(() => {
    const out: Array<{ startSquare: string; endSquare: string; color: string }> = [];
    if (!session || session.status !== 'awaiting-user') return out;
    const sideAtFen = session.currentNode.fen.split(' ')[1] === 'w' ? 'white' : 'black';
    if (sideAtFen !== session.options.userColor) return out;
    for (const c of session.currentNode.children ?? []) {
      const uci = c.move_uci ?? '';
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      if (!from || !to) continue;
      const practiced = session.practicedChildIds.has(c.id);
      const exhausted = (session.applicableCounts.get(c.id) ?? 0) === 0;
      if (practiced || exhausted) {
        out.push({ startSquare: from, endSquare: to, color: colors.danger });
      }
    }
    return out;
  }, [session, colors]);

  const orientation = opening?.color === 'white' ? 'white' : 'black';
  // Overlay X badges at the MIDPOINT of each danger arrow. The to-square may
  // be a legal destination for another piece, so the X must sit on the arrow.
  // Positions are board-percentage coords so they survive resize.
  const xOverlays = useMemo(() => {
    if (!opening) {
      return null;
    }
    if (!session) return [] as Array<{ leftPct: number; topPct: number; key: string }>;
    const sideAtFen = session.currentNode.fen.split(' ')[1] === 'w' ? 'white' : 'black';
    if (sideAtFen !== session.options.userColor) return [];
    const out: Array<{ leftPct: number; topPct: number; key: string }> = [];
    for (const a of doneArrows) {
      const fc = a.startSquare.charCodeAt(0) - 97;
      const fr = 8 - parseInt(a.startSquare[1], 10);
      const tc = a.endSquare.charCodeAt(0) - 97;
      const tr = 8 - parseInt(a.endSquare[1], 10);
      const vFc = orientation === 'white' ? fc : 7 - fc;
      const vFr = orientation === 'white' ? fr : 7 - fr;
      const vTc = orientation === 'white' ? tc : 7 - tc;
      const vTr = orientation === 'white' ? tr : 7 - tr;
      const leftPct = (((vFc + 0.5) + (vTc + 0.5)) / 2 / 8) * 100;
      const topPct = (((vFr + 0.5) + (vTr + 0.5)) / 2 / 8) * 100;
      out.push({ leftPct, topPct, key: `${a.startSquare}-${a.endSquare}` });
    }
    return out;
  }, [doneArrows, orientation, session]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return <AppShell><div className="flex-1 flex items-center justify-center"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div></AppShell>;
  }
  if (error || !session || !opening || !xOverlays) {
    return (
      <AppShell>
        <div className="flex-1 p-8">
          <p className="text-content-muted">{error ?? 'Could not start session.'}</p>
          <Link to={`/library/${id}`} className="text-accent text-sm mt-2 inline-block hover:underline">Back to opening</Link>
        </div>
      </AppShell>
    );
  }

  if (summary) return <SummaryScreen opening={opening} mode={mode} openingId={id!} summary={summary} onRestart={() => setReloadKey((k) => k + 1)} onPracticeMistakes={mode === 'learn' ? undefined : undefined /* not implemented in v1 */} />;

  const boardFen = session.currentNode.fen;
  const modeBadgeColor = mode === 'learn' ? 'bg-accent/15 text-accent' : 'bg-gold/15 text-gold';

  return (
    <AppShell>
      <div className="flex-1 flex flex-col items-center p-3 lg:p-6 lg:justify-center overflow-hidden">
        {/* Header */}
        <div className="w-full max-w-[640px] flex items-center gap-2 mb-2">
          <Link to={`/library/${id}`} className="w-8 h-8 flex items-center justify-center rounded-lg text-content-muted hover:text-content-primary hover:bg-bg-elevated">
            ←
          </Link>
          <span className={`px-2 py-0.5 text-xs font-medium rounded ${modeBadgeColor}`}>
            {mode === 'learn' ? 'Learn' : 'Practice'}
          </span>
          {session.phase === 'requeue' && (
            <span className="px-2 py-0.5 text-xs font-medium rounded bg-gold/15 text-gold">
              Re-prompt · {session.requeueEntries.length} left
            </span>
          )}
          <span className="text-content-primary text-base font-semibold truncate flex-1">{opening.name}</span>
          <span className="text-content-muted text-xs">
            {session.completedApplicable} / {session.totalApplicable}
          </span>
        </div>

        {/* Progress bar */}
        <div className="w-full max-w-[640px] h-1 bg-bg-surface rounded-full overflow-hidden mb-2">
          <div
            className={mode === 'learn' ? 'h-full bg-accent transition-all' : 'h-full bg-gold transition-all'}
            style={{ width: session.totalApplicable === 0 ? '0%' : `${(session.completedApplicable / session.totalApplicable) * 100}%` }}
          />
        </div>

        {/* Status row */}
        <div className="w-full max-w-[640px] flex items-center gap-2 mb-2 min-h-[24px]">
          {session.status === 'awaiting-user' && choiceCount > 1 && (
            <span className="text-xs text-content-secondary">
              {choiceCount} choices at this position
            </span>
          )}
          {session.status === 'opponent-to-move' && (
            <span className="text-xs text-content-muted italic">Opponent is moving…</span>
          )}
          <div className="flex-1" />
          {mode === 'learn' && session.status !== 'complete' && (
            <button
              onClick={handleEndEarly}
              title="Stop now and save first-try positions as learned"
              className="px-2 py-1 text-xs rounded-md bg-bg-elevated hover:bg-bg-surface text-content-secondary border border-border"
            >
              End early
            </button>
          )}
          {session.status === 'awaiting-user' && (
            <button
              onClick={handleHint}
              className="px-2 py-1 text-xs rounded-md bg-accent/10 hover:bg-accent/20 text-accent"
            >
              {session.hintLevel === 0 ? 'Hint (piece)' : session.hintLevel === 1 ? 'Hint (answer)' : 'Hint shown'}
            </button>
          )}
        </div>

        {/* Board — square sized to the smaller of available width/height */}
        <div
          key={shakeKey}
          className={shakeKey > 0 ? 'animate-shake' : ''}
          style={{
            width: 'min(calc(100vw - 32px), calc(100vh - 300px), 640px)',
            aspectRatio: '1 / 1',
            position: 'relative',
          }}
        >
          <BoardErrorBoundary resetKey={boardFen}>
            <Chessboard
              options={{
                position: boardFen,
                boardOrientation: orientation,
                allowDragging: session.status === 'awaiting-user',
                animationDurationInMs: 200,
                boardStyle: { borderRadius: '8px', boxShadow: '0 4px 20px rgba(0,0,0,0.3)' },
                darkSquareStyle: { backgroundColor: colors.board.dark },
                lightSquareStyle: { backgroundColor: colors.board.light },
                squareStyles: hintSquares,
                arrows: doneArrows,
                onPieceDrop: handlePieceDrop,
                canDragPiece: canDragPiece,
                dropSquareStyle: { backgroundColor: colors.accent.dim },
              }}
            />
          </BoardErrorBoundary>
          {/* X badges sitting on the arrow midpoints */}
          {xOverlays.map((x) => (
            <div
              key={x.key}
              style={{
                position: 'absolute',
                left: `${x.leftPct}%`,
                top: `${x.topPct}%`,
                transform: 'translate(-50%, -50%)',
                width: '7%',
                aspectRatio: '1 / 1',
                borderRadius: '50%',
                backgroundColor: colors.danger,
                border: '2px solid white',
                color: 'white',
                fontWeight: 900,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.9em',
                pointerEvents: 'none',
                zIndex: 5,
              }}
            >
              ✕
            </div>
          ))}
        </div>
        {/* Banner */}
        {banner && (
          <div className={`w-full max-w-[640px] px-3 py-2 mt-2 rounded-md text-sm ${
              banner.kind === 'warn' ? 'bg-gold/15 text-gold border border-gold/30' :
              banner.kind === 'err' ? 'bg-danger/10 text-danger border border-danger/30' :
                'bg-bg-elevated text-content-secondary border border-border'
            }`}>
            {banner.text}
          </div>
        )}
        {revealedSans && revealedSans.length > 0 && (
          <div className="w-full max-w-[640px] px-3 py-2 mt-2 rounded-md text-sm bg-accent/10 text-accent border border-accent/20">
            Answer: {revealedSans.join(' or ')}
          </div>
        )}

      </div>

      {confirmEndEarly && endEarlyStats && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setConfirmEndEarly(false)}
        >
          <div
            className="bg-bg-elevated border border-border rounded-xl p-6 max-w-sm mx-4 shadow-2xl w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-content-primary font-semibold mb-1">End learning early?</h3>
            <p className="text-content-muted text-sm mb-4">
              <span className="text-accent font-medium">{endEarlyStats.learnedNow}</span>{' '}
              position{endEarlyStats.learnedNow === 1 ? '' : 's'} you got on the first try will be marked learned.
              {endEarlyStats.remaining > 0 && (
                <>
                  {' '}
                  <span className="text-content-secondary">{endEarlyStats.remaining}</span>{' '}
                  position{endEarlyStats.remaining === 1 ? '' : 's'} will remain unlearned for next time.
                </>
              )}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmEndEarly(false)}
                className="flex-1 py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface"
              >
                Keep going
              </button>
              <button
                onClick={confirmEnd}
                className="flex-1 py-2 rounded-lg bg-accent text-bg-base font-medium text-sm hover:bg-accent-hover"
              >
                End now
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

// ── Summary ────────────────────────────────────────────────────────────────

function SummaryScreen({
  opening, openingId, mode, summary, onRestart,
}: {
  opening: Opening;
  openingId: string;
  mode: PracticeMode;
  summary: SessionSummary;
  onRestart: () => void;
  onPracticeMistakes?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <AppShell>
      <div className="flex-1 flex flex-col items-center p-6 overflow-y-auto">
        <div className="w-full max-w-[640px]">
          <Link to={`/library/${openingId}`} className="text-accent text-sm hover:underline">← Back to opening</Link>
          <h1 className="text-content-primary text-2xl font-semibold mt-3 mb-1">
            {mode === 'learn' ? 'Learning session complete' : 'Practice session complete'}
          </h1>
          <p className="text-content-muted text-sm mb-6">{opening.name}</p>

          <div className="grid grid-cols-3 gap-3 mb-6">
            <Stat label="Completed" value={`${summary.completedApplicable} / ${summary.totalApplicable}`} tone="ok" />
            <Stat label="Mistakes" value={String(summary.mistakes.length)} tone={summary.mistakes.length > 0 ? 'err' : 'ok'} />
            <Stat label="Hinted" value={String(summary.hintedNodeIds.length)} tone="info" />
          </div>

          {summary.mistakes.length > 0 && (
            <>
              <h2 className="text-content-primary text-base font-semibold mb-2">Mistakes</h2>
              <ul className="space-y-2 mb-6">
                {summary.mistakes.map((m, i) => (
                  <li key={i} className="bg-bg-surface border border-border rounded-lg px-3 py-2 flex items-center gap-2">
                    <span className="text-danger text-sm font-mono">{m.attemptedSan}</span>
                    <span className="text-content-muted text-xs">→ expected: <span className="text-content-secondary">{m.expectedSans.join(' / ') || '—'}</span></span>
                    <div className="flex-1" />
                    <button
                      onClick={() => navigate(`/library/${openingId}?node=${m.nodeId}`)}
                      className="text-accent text-xs hover:underline"
                    >
                      Open
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="flex gap-2">
            <Link to={`/library/${openingId}`} className="flex-1 py-2 text-center rounded-lg border border-border text-content-secondary hover:bg-bg-surface">Done</Link>
            {mode === 'learn' && summary.completedApplicable < summary.totalApplicable ? (
              <button
                onClick={onRestart}
                className="flex-1 py-2 rounded-lg bg-accent text-bg-base font-medium hover:bg-accent-hover"
              >
                Keep learning
              </button>
            ) : (
              <button
                onClick={() => {
                  if (mode === 'practice') onRestart();
                  else navigate(`/practice/${openingId}?mode=practice`);
                }}
                className="flex-1 py-2 rounded-lg bg-accent text-bg-base font-medium hover:bg-accent-hover"
              >
                {mode === 'learn' ? 'Practice more' : 'Practice again'}
              </button>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'err' | 'info' }) {
  const toneCls = tone === 'ok' ? 'text-accent' : tone === 'err' ? 'text-danger' : 'text-gold';
  return (
    <div className="bg-bg-surface border border-border rounded-lg p-3">
      <div className="text-content-muted text-xs uppercase tracking-wider">{label}</div>
      <div className={`text-xl font-semibold mt-0.5 ${toneCls}`}>{value}</div>
    </div>
  );
}
