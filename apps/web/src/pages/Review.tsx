import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import Icon from '@mdi/react';
import { mdiChessKing, mdiFire } from '@mdi/js';
import { AppShell } from '@/components/AppShell';
import { useColorTheme } from '@/hooks/useColorTheme';
import { legalTargetStyles } from '@/lib/board-highlights';
import {
  getDueReviews,
  gradeReview,
  getReviewStats,
  getStreak,
  type ReviewItem,
  type ReviewStats,
  type Streak,
  applySm2,
  intervalLabel,
  type Quality,
} from '@pawnki/shared';
import { readReviewOrder } from '@/hooks/useReviewOrder';
// gradeReview is used by the parent Review component below.

type Stage = 'entry' | 'session' | 'done';
type AttemptState =
  | { kind: 'attempting'; wrongCount: number }
  | { kind: 'revealed'; verdict: 'correct' | 'wrong' | 'shown'; wrongCount: number };

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

const QUALITIES: Array<{ q: Quality; label: string; desc: string; tone: string }> = [
  { q: 1, label: 'Again', desc: 'Missed it',           tone: 'bg-danger/15 text-danger border-danger/30 hover:bg-danger/25' },
  { q: 2, label: 'Hard',  desc: 'Recalled with effort', tone: 'bg-gold/15 text-gold border-gold/30 hover:bg-gold/25' },
  { q: 4, label: 'Good',  desc: 'Got it',               tone: 'bg-accent/15 text-accent border-accent/30 hover:bg-accent/25' },
  { q: 5, label: 'Easy',  desc: 'Effortless',           tone: 'bg-accent/25 text-accent border-accent/40 hover:bg-accent/35' },
];

interface GradeResult {
  reviewId: string;
  quality: Quality;
  wrongCount: number;
  /** True if this grade requeued the position instead of finalizing it. */
  requeued: boolean;
}

export default function Review() {
  const [stage, setStage] = useState<Stage>('entry');
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [originalTotal, setOriginalTotal] = useState(0);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [streak, setStreak] = useState<Streak | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionResults, setSessionResults] = useState<GradeResult[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => { void loadEntry(); }, []);

  // Done when we've walked past the (possibly growing) queue.
  useEffect(() => {
    if (stage === 'session' && idx >= items.length && items.length > 0) {
      setStage('done');
      void loadEntry();
    }
  }, [stage, idx, items.length]);

  async function loadEntry() {
    setLoading(true);
    setError(null);
    try {
      const [s, st] = await Promise.all([
        getReviewStats(),
        getStreak().catch(() => null),
      ]);
      setStats(s);
      setStreak(st);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load review stats');
    } finally {
      setLoading(false);
    }
  }

  async function startSession() {
    setLoading(true);
    setError(null);
    try {
      const due = await getDueReviews(readReviewOrder());
      if (due.length === 0) {
        await loadEntry();
        return;
      }
      setItems(due);
      setIdx(0);
      setOriginalTotal(due.length);
      setSessionResults([]);
      setSessionError(null);
      setStage('session');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load due cards');
    } finally {
      setLoading(false);
    }
  }

  // Quality === 1 (Again): don't persist; requeue at end of session.
  // Quality >= 2 (Hard, Good, Easy): persist via SM-2 and advance.
  async function handleGraded(quality: Quality, wrongCount: number) {
    const current = items[idx];
    if (!current) return;
    const requeued = quality === 1;
    setSessionResults((r) => [...r, { reviewId: current.review.id, quality, wrongCount, requeued }]);
    if (requeued) {
      setItems((arr) => [...arr, current]);
      setIdx((i) => i + 1);
      return;
    }
    try {
      await gradeReview(current.review, quality);
      setIdx((i) => i + 1);
    } catch (e: any) {
      // Requeue on failure so progress isn't lost.
      setSessionError(e?.message ?? 'Failed to save grade — will retry at end of session');
      setItems((arr) => [...arr, current]);
      setIdx((i) => i + 1);
    }
  }

  if (loading && stage === 'entry') {
    return <AppShell><div className="flex-1 flex items-center justify-center"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div></AppShell>;
  }

  if (stage === 'session' && idx < items.length) {
    const finalized = sessionResults.filter((r) => !r.requeued).length;
    // Once the user has voluntarily Miss/Hard'd a position in this session, lock
    // the ceiling at that grade — they can't claim Good/Easy on the retry. Only
    // q<3 grades count: a Good/Easy that was auto-requeued by a save failure is
    // not the user's fault and shouldn't cap the retry.
    const currentReviewId = items[idx].review.id;
    let maxQuality: Quality = 5;
    for (const r of sessionResults) {
      if (r.reviewId === currentReviewId && r.quality < 3 && r.quality < maxQuality) {
        maxQuality = r.quality;
      }
    }
    return (
      <ReviewSession
        key={`${items[idx].review.id}-${idx}`}
        item={items[idx]}
        finalized={finalized}
        originalTotal={originalTotal}
        sessionError={sessionError}
        maxQuality={maxQuality}
        onClearError={() => setSessionError(null)}
        onGraded={handleGraded}
        onQuit={() => { setStage('entry'); void loadEntry(); }}
      />
    );
  }

  if (stage === 'done') {
    return <DoneScreen results={sessionResults} originalTotal={originalTotal} streak={streak} onBack={() => setStage('entry')} />;
  }

  return <EntryScreen stats={stats} streak={streak} error={error} onStart={startSession} />;
}

// ── Entry ─────────────────────────────────────────────────────────────────

function EntryScreen({
  stats, streak, error, onStart,
}: { stats: ReviewStats | null; streak: Streak | null; error: string | null; onStart: () => void }) {
  const hasDue = (stats?.dueToday ?? 0) > 0;
  return (
    <AppShell>
      <div className="flex-1 p-6 lg:p-8 max-w-2xl mx-auto w-full">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-content-primary text-2xl font-semibold">Daily Review</h1>
          {streak && streak.current > 0 && (
            <span
              title={streak.atRisk ? 'Review today to keep your streak alive' : 'Daily review streak'}
              className={[
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border',
                streak.atRisk
                  ? 'bg-gold/15 text-gold border-gold/30'
                  : 'bg-accent/15 text-accent border-accent/30',
              ].join(' ')}
            >
              <Icon path={mdiFire} size={0.6} />
              {streak.current} {streak.current === 1 ? 'day' : 'days'}
              {streak.atRisk ? ' · at risk' : ''}
            </span>
          )}
        </div>
        <p className="text-content-muted text-sm mb-6">
          Spaced repetition over the positions you've learned. Quick sessions, every day.
        </p>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-md bg-danger/10 text-danger border border-danger/30 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3 mb-8">
          <Metric label="Due today" value={String(stats?.dueToday ?? 0)} accent={hasDue} />
          <Metric label="In repertoire" value={String(stats?.totalLearned ?? 0)} />
          <Metric
            label="Retention"
            value={stats?.retention === null ? '—' : `${stats?.retention ?? 0}%`}
          />
        </div>

        {hasDue ? (
          <button
            onClick={onStart}
            className="w-full py-4 rounded-xl bg-accent text-bg-base font-semibold hover:bg-accent-hover transition-colors shadow-sm shadow-accent/20"
          >
            Start review · {stats!.dueToday} {stats!.dueToday === 1 ? 'position' : 'positions'}
          </button>
        ) : (
          <div className="text-center py-10 border border-dashed border-border rounded-xl">
            <p className="text-content-primary font-medium mb-1">All caught up</p>
            <p className="text-content-muted text-sm">
              {stats?.totalLearned === 0
                ? 'Learn an opening to start collecting reviews.'
                : 'Come back tomorrow to keep your streak going.'}
            </p>
            <Link to="/library" className="inline-block mt-4 text-accent text-sm hover:underline">
              Go to library →
            </Link>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-bg-surface border border-border rounded-xl p-4">
      <div className="text-content-muted text-xs uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${accent ? 'text-accent' : 'text-content-primary'}`}>
        {value}
      </div>
    </div>
  );
}

// ── Session ───────────────────────────────────────────────────────────────

function ReviewSession({
  item, finalized, originalTotal, sessionError, maxQuality, onClearError, onGraded, onQuit,
}: {
  item: ReviewItem;
  /** Number of positions already finalized (graded Good/Easy). */
  finalized: number;
  /** Original due count at session start (drives the progress bar). */
  originalTotal: number;
  sessionError: string | null;
  /** Ceiling on selectable grade — lowered to the user's previous Miss/Hard
   *  for this position in the current session so retries can't inflate. */
  maxQuality: Quality;
  onClearError: () => void;
  onGraded: (quality: Quality, wrongCount: number) => Promise<void>;
  onQuit: () => void;
}) {
  const { colors } = useColorTheme();
  const [attempt, setAttempt] = useState<AttemptState>({ kind: 'attempting', wrongCount: 0 });
  const [shakeKey, setShakeKey] = useState(0);
  const [banner, setBanner] = useState<{ text: string; kind: 'info' | 'err' } | null>(null);
  const [grading, setGrading] = useState(false);
  const [hintLevel, setHintLevel] = useState<0 | 1 | 2>(0);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // Source square the user is grabbing/tapping — drawn green for clarity.
  const [activeSquare, setActiveSquare] = useState<string | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ReviewSession is remounted per item via a `key` prop on the parent — no
  // need to manually reset state when item changes.

  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); }, []);

  const showBanner = useCallback((text: string, kind: 'info' | 'err', timeout = 2000) => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ text, kind });
    bannerTimer.current = setTimeout(() => setBanner(null), timeout);
  }, []);

  const orientation = item.opening.color === 'white' ? 'white' : 'black';
  // Board fen depends on phase: attempting → parent (user to move); revealed → node (after correct move).
  const boardFen = attempt.kind === 'attempting' ? item.parent.fen : item.node.fen;

  const tryMove = useCallback((from: string, to: string): boolean => {
    if (attempt.kind !== 'attempting') return false;
    const chess = new Chess(item.parent.fen);
    // chess.js v1 throws on illegal moves; letting the throw escape would
    // strand react-chessboard's drag state and leave the piece at opacity 0.5.
    let result;
    try {
      result = chess.move({ from, to, promotion: 'q' });
    } catch {
      result = null;
    }
    if (!result) {
      showBanner('Invalid move', 'err');
      return false;
    }
    const san = result.san;
    if (item.acceptedSans.includes(san)) {
      const wc = attempt.wrongCount;
      setAttempt({ kind: 'revealed', verdict: wc > 0 ? 'wrong' : 'correct', wrongCount: wc });
      showBanner(wc > 0 ? 'Correct — but you stumbled' : 'Correct', 'info', 800);
      return true;
    }
    setAttempt((a) => a.kind === 'attempting' ? { ...a, wrongCount: a.wrongCount + 1 } : a);
    setShakeKey((k) => k + 1);
    showBanner('Not quite — try again or show answer', 'err');
    return false;
  }, [attempt, item, showBanner]);

  const handlePieceDrop = useCallback(({ sourceSquare, targetSquare }: {
    piece: unknown; sourceSquare: string; targetSquare: string | null;
  }): boolean => {
    if (!targetSquare) return false;
    return tryMove(sourceSquare, targetSquare);
  }, [tryMove]);

  const isUserPiece = useCallback((piece: { pieceType: string } | null | undefined): boolean => {
    if (!piece) return false;
    const userIsWhite = item.opening.color === 'white';
    return userIsWhite === (piece.pieceType[0] === 'w');
  }, [item]);

  const canDragPiece = useCallback(({ piece }: { piece: { pieceType: string } }): boolean => {
    if (attempt.kind !== 'attempting') return false;
    return isUserPiece(piece);
  }, [attempt, isUserPiece]);

  const handleSquareClick = useCallback((args: { square: string | null; piece: { pieceType: string } | null }) => {
    if (attempt.kind !== 'attempting' || !args.square) return;
    const { square, piece } = args;
    if (activeSquare && square !== activeSquare) {
      if (isUserPiece(piece)) {
        setActiveSquare(square);
        return;
      }
      tryMove(activeSquare, square);
      setActiveSquare(null);
      return;
    }
    if (square === activeSquare) {
      setActiveSquare(null);
      return;
    }
    if (isUserPiece(piece)) setActiveSquare(square);
  }, [attempt, activeSquare, isUserPiece, tryMove]);

  // Two-stage hint: level 0 → 1 highlights the piece(s) to move; level 1 → 2
  // reveals the answer (transitions to revealed state).
  const handleHint = useCallback(() => {
    if (attempt.kind !== 'attempting') return;
    if (hintLevel === 0) {
      setHintLevel(1);
    } else {
      setHintLevel(2);
      setAttempt({ kind: 'revealed', verdict: attempt.wrongCount > 0 ? 'wrong' : 'shown', wrongCount: attempt.wrongCount });
    }
  }, [attempt, hintLevel]);

  const handleGrade = useCallback(async (quality: Quality) => {
    if (attempt.kind !== 'revealed' || grading) return;
    setGrading(true);
    // Parent handles persistence + queue management. We just signal the choice.
    await onGraded(quality, attempt.wrongCount);
  }, [attempt, grading, onGraded]);

  // Arrow showing the answer once revealed.
  const answerArrow = useMemo(() => {
    if (attempt.kind !== 'revealed') return [];
    const uci = item.node.move_uci ?? '';
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    if (!from || !to) return [];
    return [{ startSquare: from, endSquare: to, color: attempt.verdict === 'wrong' ? colors.danger : colors.accent.default }];
  }, [attempt, item, colors]);

  // Piece highlight when hintLevel >= 1 and still attempting.
  const hintSquares = useMemo(() => {
    if (hintLevel === 0 || attempt.kind !== 'attempting') return {} as Record<string, React.CSSProperties>;
    const styles: Record<string, React.CSSProperties> = {};
    for (const sq of item.acceptedFromSquares) {
      styles[sq] = { boxShadow: `inset 0 0 0 3px ${colors.accent.default}` };
    }
    return styles;
  }, [hintLevel, attempt, item, colors]);

  const legalSquareStyles = useMemo(() => {
    if (attempt.kind !== 'attempting' || !activeSquare) return {};
    return legalTargetStyles(item.parent.fen, activeSquare, colors.accent.default);
  }, [attempt, activeSquare, item, colors]);

  // Progress bar reflects finalized positions vs the original due count.
  // Re-queued positions don't move the bar until they're finally graded ≥ Good.
  const progressPct = originalTotal === 0 ? 0 : Math.min(100, (finalized / originalTotal) * 100);
  const turnLabel = item.opening.color === 'white' ? 'White to move' : 'Black to move';

  // Preview intervals for each grade button (so user knows what they're picking).
  const previews = useMemo(() => {
    const prev = { interval: item.review.interval, ease_factor: item.review.ease_factor, repetitions: item.review.repetitions };
    return new Map<Quality, string>(QUALITIES.map(({ q }) => [q, intervalLabel(applySm2(prev, q).interval)]));
  }, [item.review]);

  return (
    <AppShell>
      <div className="flex-1 flex flex-col items-center p-3 lg:p-6 lg:justify-center overflow-hidden">
        {/* Header */}
        <div className="w-full max-w-[640px] flex items-center gap-2 mb-2">
          <button
            onClick={() => setConfirmEnd(true)}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-content-muted hover:text-content-primary hover:bg-bg-elevated shrink-0"
            title="End review"
          >
            ←
          </button>
          {/* Opening identity — prominent because the same position can recur
              across openings with different intended moves. */}
          <div
            className={[
              'flex items-center gap-1.5 px-2.5 py-1 rounded-md border min-w-0 flex-1',
              item.opening.color === 'white'
                ? 'border-gold/40 bg-gold/10'
                : 'border-accent/40 bg-accent/10',
            ].join(' ')}
            title={`Playing as ${item.opening.color} — ${item.opening.name}`}
          >
            <Icon
              path={mdiChessKing}
              size={0.75}
              color={`rgb(var(--color-${item.opening.color === 'white' ? 'gold' : 'accent'}))`}
            />
            <span className="text-content-primary text-sm font-semibold truncate">
              {item.opening.name}
            </span>
          </div>
          <span className="text-content-muted text-xs shrink-0" title="Finalized / originally due">
            {finalized} / {originalTotal}
          </span>
        </div>

        {/* Progress bar */}
        <div className="w-full max-w-[640px] h-1 bg-bg-surface rounded-full overflow-hidden mb-2">
          <div className="h-full bg-accent transition-all" style={{ width: `${progressPct}%` }} />
        </div>

        {/* Prompt row */}
        <div className="w-full max-w-[640px] flex items-center gap-2 mb-2 min-h-[24px]">
          <span className="text-xs text-content-secondary">
            {attempt.kind === 'attempting' ? turnLabel : 'Answer'}
          </span>
          {attempt.kind === 'attempting' && item.acceptedSans.length > 1 && (
            <span className="text-xs text-content-muted">
              · {item.acceptedSans.length} valid answers
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={() => setConfirmEnd(true)}
            title="End now (your grades so far are saved)"
            className="px-2 py-1 text-xs rounded-md bg-bg-elevated hover:bg-bg-surface text-content-secondary border border-border"
          >
            End early
          </button>
          {attempt.kind === 'attempting' && (
            <button
              onClick={handleHint}
              className="px-2 py-1 text-xs rounded-md bg-accent/10 hover:bg-accent/20 text-accent"
            >
              {hintLevel === 0 ? 'Hint' : 'Show answer'}
            </button>
          )}
        </div>

        {/* Board */}
        <div
          key={shakeKey}
          className={shakeKey > 0 && attempt.kind === 'attempting' ? 'animate-shake' : ''}
          style={{
            width: 'min(calc(100vw - 32px), calc(100vh - 360px), 640px)',
            aspectRatio: '1 / 1',
            position: 'relative',
          }}
        >
          <BoardErrorBoundary resetKey={boardFen}>
            <Chessboard
              options={{
                position: boardFen,
                boardOrientation: orientation,
                allowDragging: attempt.kind === 'attempting',
                animationDurationInMs: 200,
                boardStyle: { borderRadius: '8px', boxShadow: '0 4px 20px rgba(0,0,0,0.3)' },
                darkSquareStyle: { backgroundColor: colors.board.dark },
                lightSquareStyle: { backgroundColor: colors.board.light },
                arrows: answerArrow,
                squareStyles: activeSquare
                  ? {
                      ...legalSquareStyles,
                      ...hintSquares,
                      [activeSquare]: {
                        backgroundColor: 'rgb(var(--color-accent) / 0.5)',
                        boxShadow: 'inset 0 0 0 4px rgb(var(--color-accent))',
                        ...(hintSquares[activeSquare] ?? {}),
                      },
                    }
                  : hintSquares,
                onPieceDrop: (args) => {
                  setActiveSquare(null);
                  return handlePieceDrop(args);
                },
                onPieceDrag: ({ square }: { square: string | null }) => {
                  if (square) setActiveSquare(square);
                },
                onSquareClick: handleSquareClick,
                canDragPiece: canDragPiece,
                dropSquareStyle: { backgroundColor: colors.accent.dim },
              }}
            />
          </BoardErrorBoundary>
        </div>

        {/* Banner */}
        {banner && (
          <div className={`w-full max-w-[640px] px-3 py-2 mt-2 rounded-md text-sm ${
              banner.kind === 'err' ? 'bg-danger/10 text-danger border border-danger/30' :
                'bg-bg-elevated text-content-secondary border border-border'
            }`}>
            {banner.text}
          </div>
        )}
        {sessionError && (
          <div className="w-full max-w-[640px] px-3 py-2 mt-2 rounded-md text-sm bg-danger/10 text-danger border border-danger/30 flex items-center gap-2">
            <span className="flex-1">{sessionError}</span>
            <button onClick={onClearError} className="text-xs underline">dismiss</button>
          </div>
        )}

        {/* Answer label + annotation on reveal */}
        {attempt.kind === 'revealed' && (
          <div className="w-full max-w-[640px] mt-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-content-muted">Answer:</span>
              <span className="font-mono text-content-primary font-semibold">{item.node.move_san}</span>
              {attempt.verdict === 'correct' && <span className="text-accent text-xs">✓ first try</span>}
              {attempt.verdict === 'wrong' && <span className="text-danger text-xs">missed</span>}
              {attempt.verdict === 'shown' && <span className="text-content-muted text-xs">revealed</span>}
            </div>
            {item.node.annotation && (
              <p className="text-content-secondary text-sm mt-1">{item.node.annotation}</p>
            )}
          </div>
        )}

        {/* Grade buttons */}
        {attempt.kind === 'revealed' && (
          <>
            {maxQuality < 5 && (
              <p className="w-full max-w-[640px] text-xs text-content-muted mt-2">
                You previously {maxQuality === 1 ? 'missed' : 'struggled with'} this position — grades above that are locked for this session.
              </p>
            )}
            <div className="w-full max-w-[640px] grid grid-cols-4 gap-2 mt-3">
              {QUALITIES.map(({ q, label, desc, tone }) => {
                const lockedByCap = q > maxQuality;
                const disabled = grading || lockedByCap;
                const title = lockedByCap
                  ? 'Disabled because you already graded this position lower in this session'
                  : undefined;
                return (
                  <button
                    key={q}
                    onClick={() => handleGrade(q)}
                    disabled={disabled}
                    title={title}
                    className={`px-2 py-3 rounded-lg border text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex flex-col items-center gap-0.5 ${tone}`}
                  >
                    <span>{label}</span>
                    <span className="text-[10px] opacity-75 font-normal">{previews.get(q)}</span>
                    <span className="text-[10px] opacity-60 font-normal hidden sm:block">{desc}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {confirmEnd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setConfirmEnd(false)}
        >
          <div
            className="bg-bg-elevated border border-border rounded-xl p-6 max-w-sm mx-4 shadow-2xl w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-content-primary font-semibold mb-1">End review?</h3>
            <p className="text-content-muted text-sm mb-4">
              <span className="text-accent font-medium">{finalized}</span>{' '}
              position{finalized === 1 ? '' : 's'} graded and saved.
              {' '}
              <span className="text-content-secondary">{Math.max(0, originalTotal - finalized)}</span>{' '}
              left — they'll come back next time.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmEnd(false)}
                className="flex-1 py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface"
              >
                Keep going
              </button>
              <button
                onClick={() => { setConfirmEnd(false); onQuit(); }}
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

// ── Done ──────────────────────────────────────────────────────────────────

function DoneScreen({
  results, originalTotal, streak, onBack,
}: { results: GradeResult[]; originalTotal: number; streak: Streak | null; onBack: () => void }) {
  // First-try = the very first time we saw a position, no wrong attempts, and
  // graded Good/Easy. Requeues don't count even if the user nails them later.
  const seen = new Set<string>();
  let firstTry = 0;
  for (const r of results) {
    const isFirst = !seen.has(r.reviewId);
    seen.add(r.reviewId);
    if (isFirst && !r.requeued && r.wrongCount === 0) firstTry += 1;
  }
  const requeues = results.filter((r) => r.requeued).length;
  const streakValue = streak?.current ?? 0;
  return (
    <AppShell>
      <div className="flex-1 p-6 lg:p-8 max-w-2xl mx-auto w-full">
        <h1 className="text-content-primary text-2xl font-semibold mb-1">Review complete</h1>
        <p className="text-content-muted text-sm mb-6">
          {originalTotal} {originalTotal === 1 ? 'position' : 'positions'} reviewed.
          {streakValue > 0 && (
            <>
              {' '}
              <span className="text-accent font-medium">
                {streakValue}-day streak {streakValue === 1 ? 'started' : 'kept alive'}.
              </span>
            </>
          )}
        </p>

        <div className="grid grid-cols-3 gap-3 mb-6">
          <Metric label="First try" value={`${firstTry}`} accent={firstTry > 0} />
          <Metric label="Requeued" value={`${requeues}`} />
          <Metric label="Accuracy" value={originalTotal === 0 ? '—' : `${Math.round((firstTry / originalTotal) * 100)}%`} />
        </div>

        <div className="flex gap-2">
          <button
            onClick={onBack}
            className="flex-1 py-3 rounded-lg border border-border text-content-secondary hover:bg-bg-surface"
          >
            Done
          </button>
          <Link
            to="/library"
            className="flex-1 py-3 text-center rounded-lg bg-accent text-bg-base font-medium hover:bg-accent-hover"
          >
            Library
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
