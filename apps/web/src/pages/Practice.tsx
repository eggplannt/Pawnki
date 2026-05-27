import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { AppShell } from '@/components/AppShell';
import {
  getOpening,
  getNodes,
  buildTree,
  getLearnedNodeIds,
  markPositionsLearned,
  startSession,
  attemptMove,
  opponentMove,
  showHint,
  finalize,
  applicableChildren,
  mistakeDecisionPath,
  mistakeMovePrefix,
  type PracticeSession,
  type PracticeMode,
  type SessionSummary,
  type Node,
  type Opening,
  usePremium,
} from '@pawnki/shared';
import { useColorTheme } from '@/hooks/useColorTheme';
import { legalTargetStyles } from '@/lib/board-highlights';
import { PreSessionAd } from '@/components/PreSessionAd';

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

/**
 * Learn mode: walk the session forward through every move that would otherwise
 * auto-play (opponent replies + user moves the user already knows or forced
 * non-teaching choices) until we hit a stop — i.e. a teaching move, a real
 * branching decision, completion, or backtrack-stuck state. Returns the final
 * session plus the number of steps taken. Pure; doesn't mutate input.
 */
function fastForwardLearn(start: PracticeSession): { session: PracticeSession; steps: number } {
  let cur = start;
  let steps = 0;
  // Safety cap so a buggy state can't loop forever.
  while (steps < 256) {
    if (cur.status === 'complete') break;
    if (cur.status === 'opponent-to-move') {
      const next = opponentMove(cur).session;
      if (next === cur || next.currentNode.id === cur.currentNode.id) break;
      cur = next;
      steps++;
      continue;
    }
    // awaiting-user
    const applicable = applicableChildren(cur);
    if (applicable.length !== 1) break; // user has a real choice → stop
    const target = applicable[0];
    const targetLearnable = cur.learnableMap.get(target.id) ?? false;
    const isTeaching = targetLearnable && !cur.options.learnedNodeIds.has(target.id);
    if (isTeaching) break; // first time encountering this answer → stop and ask
    const san = target.move_san;
    if (!san) break;
    const next = attemptMove(cur, san).session;
    if (next === cur || next.currentNode.id === cur.currentNode.id) break;
    cur = next;
    steps++;
  }
  return { session: cur, steps };
}

export default function Practice() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { colors } = useColorTheme();

  const mode = (searchParams.get('mode') as PracticeMode) ?? 'learn';
  const fromNodeId = searchParams.get('from');
  const randomizeOrder = searchParams.get('random') === '1';

  const { loading: premiumLoading } = usePremium();
  const [adDone, setAdDone] = useState(mode !== 'practice');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [banner, setBanner] = useState<{ text: string; kind: 'info' | 'warn' | 'err' } | null>(null);
  const [revealedSans, setRevealedSans] = useState<string[] | null>(null);
  const [hintSquares, setHintSquares] = useState<Record<string, React.CSSProperties>>({});
  // Square the user is actively grabbing or has tapped — drawn green so the
  // selection is obvious instead of the piece just going semi-transparent.
  const [activeSquare, setActiveSquare] = useState<string | null>(null);
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
          randomizeOrder,
        });
        setSession(newSession);
        setLoading(false);
      } catch (e: any) {
        if (!cancelled) { setError(e?.message ?? 'Failed to start session'); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mode, fromNodeId, randomizeOrder, reloadKey]);

  // ── Banner helper ────────────────────────────────────────────────────────

  const showBanner = useCallback((text: string, kind: 'info' | 'warn' | 'err', timeout: number = 2500) => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ text, kind });
    bannerTimer.current = setTimeout(() => setBanner(null), timeout);
  }, []);

  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); }, []);

  // ── Auto-advance (opponent moves + learn-mode auto-skip) ─────────────────
  //
  // Practice mode: opponent plays one move at a time with a 300ms delay so the
  // user sees each move animate.
  //
  // Learn mode: we collapse chains of auto-played moves (opponent replies plus
  // user moves that are already learned or non-teaching forced choices) into a
  // single transition. If exactly one auto move separates the current position
  // from the next teaching/decision stop, we animate it with the usual delay.
  // If two or more separate them — e.g. opponent reply + walked-through
  // known line, or a long jump back to another subtree after backtracking —
  // we skip straight to the next stop without animating intermediate steps.
  // (Walking the board through positions the user knows is noise.)
  useEffect(() => {
    if (!session || session.status === 'complete') return;

    if (session.options.mode === 'practice') {
      if (session.status !== 'opponent-to-move') return;
      const t = setTimeout(() => {
        setSession((s) => (s && s.status === 'opponent-to-move' ? opponentMove(s).session : s));
      }, OPPONENT_DELAY_MS);
      return () => clearTimeout(t);
    }

    // Learn mode — fast-forward the entire auto-chain in one pass.
    const { session: target, steps } = fastForwardLearn(session);
    if (steps === 0) return;
    if (steps === 1) {
      const t = setTimeout(() => setSession(target), OPPONENT_DELAY_MS);
      return () => clearTimeout(t);
    }
    // Multi-hop: jump silently to the destination, no intermediate redraws.
    setSession(target);
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
        if (toInsert.length > 0) await markPositionsLearned(toInsert);
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
    setActiveSquare(null);
  }, [session?.currentNode.id]);

  // ── User move (drag) ─────────────────────────────────────────────────────

  const tryMove = useCallback((from: string, to: string): boolean => {
    if (!session || session.status !== 'awaiting-user') return false;
    const chess = new Chess(session.currentNode.fen);
    // chess.js v1 throws on illegal moves; let it surface as a normal "invalid".
    // Letting the throw escape would break react-chessboard's drag cleanup
    // (the dropped piece keeps the dragging-ghost opacity).
    let result;
    try {
      result = chess.move({ from, to, promotion: 'q' });
    } catch {
      result = null;
    }
    if (!result) {
      return false;
    }
    const wasRequeue = session.phase === 'requeue';
    const out = attemptMove(session, result.san);
    setSession(out.session);
    if (out.verdict === 'correct') {
      const goesToEnd = mode === 'learn'
        ? session.wrongAttemptsHere > 0
        : session.wrongAttemptsHere > 0 || session.hintLevel > 0;
      if (goesToEnd) {
        showBanner('Correct — but you stumbled. We\'ll re-ask this at the end.', 'info', 3500);
      } else showBanner('Correct', 'info', 500);
    } else if (out.verdict === 'wrong') {
      setShakeKey((k) => k + 1);
      showBanner(out.reason ?? 'Wrong move.', 'err');
    } else if (out.verdict === 'wrong-disallowed') {
      showBanner(out.reason ?? 'Already practiced.', 'info');
    } else if (out.verdict === 'wrong-mode') {
      showBanner(out.reason ?? 'Not allowed in this mode.', 'warn');
    }
    // Requeue is flashcard-style: a correct answer never advances the board
    // to "after the move" — we either jump to the next requeue parent or
    // transition to complete. Reject the drop visually so the piece snaps
    // back to source instead of stranding on the drop square.
    if (wasRequeue) return false;
    return out.verdict === 'correct';
  }, [session, mode, showBanner]);

  const handlePieceDrop = useCallback(({ sourceSquare, targetSquare }: {
    piece: unknown; sourceSquare: string; targetSquare: string | null;
  }): boolean => {
    if (!targetSquare) return false;
    return tryMove(sourceSquare, targetSquare);
  }, [tryMove]);

  const isUserPiece = useCallback((piece: { pieceType: string } | null | undefined): boolean => {
    if (!session || !piece) return false;
    const userIsWhite = session.options.userColor === 'white';
    return userIsWhite === (piece.pieceType[0] === 'w');
  }, [session]);

  const canDragPiece = useCallback(({ piece }: { piece: { pieceType: string } }): boolean => {
    if (!session || session.status !== 'awaiting-user') return false;
    return isUserPiece(piece);
  }, [session, isUserPiece]);

  // Click-to-move: first click on a user piece selects it; next click on a
  // different square attempts the move; clicking another user piece switches
  // selection; clicking the same square or elsewhere clears.
  const handleSquareClick = useCallback((args: { square: string | null; piece: { pieceType: string } | null }) => {
    if (!session || session.status !== 'awaiting-user' || !args.square) return;
    const { square, piece } = args;
    if (activeSquare && square !== activeSquare) {
      // Switch selection if user clicks one of their own pieces; otherwise treat as move target.
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
  }, [session, activeSquare, isUserPiece, tryMove]);

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
    if (!session || session.status !== 'awaiting-user' || mode === "learn") return out;
    // During requeue the user is re-prompting a single specific position;
    // "already-done this session" arrows would be noise here.
    if (session.phase === 'requeue') return out;
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

  const legalSquareStyles = useMemo(() => {
    if (!session || session.status !== 'awaiting-user' || !activeSquare) return {};
    return legalTargetStyles(session.currentNode.fen, activeSquare, colors.accent.default);
  }, [session, activeSquare, colors]);

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

  if (loading || premiumLoading) {
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

  if (!adDone) {
    return <PreSessionAd onComplete={() => setAdDone(true)} />;
  }

  if (summary) return <SummaryScreen opening={opening} mode={mode} openingId={id!} summary={summary} rootNode={session!.options.rootNode} onRestart={() => setReloadKey((k) => k + 1)} onPracticeMistakes={mode === 'learn' ? undefined : undefined /* not implemented in v1 */} />;

  const boardFen = session.currentNode.fen;
  const modeBadgeColor = mode === 'learn' ? 'bg-accent/15 text-accent' : 'bg-gold/15 text-gold';

  return (
    <AppShell>
      <div className="flex-1 flex flex-col items-center p-3 lg:p-6 lg:justify-center overflow-hidden">
        {/* Header */}
        <div className="w-full max-w-[640px] flex items-center gap-2 mb-2">
          {mode === 'learn' && session.status !== 'complete' ? (
            <button
              onClick={handleEndEarly}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-content-muted hover:text-content-primary hover:bg-bg-elevated"
              title="End learning early (saves first-try positions)"
            >
              ←
            </button>
          ) : (
            <Link to={`/library/${id}`} className="w-8 h-8 flex items-center justify-center rounded-lg text-content-muted hover:text-content-primary hover:bg-bg-elevated">
              ←
            </Link>
          )}
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
          {session.status === 'awaiting-user' && session.hintLevel < 2 && (
            <button
              onClick={handleHint}
              className="px-2 py-1 text-xs rounded-md bg-accent/10 hover:bg-accent/20 text-accent"
            >
              {session.hintLevel === 0 ? 'Hint' : 'Show answer'}
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
                squareStyles: activeSquare
                  ? {
                      ...legalSquareStyles,
                      ...hintSquares,
                      [activeSquare]: {
                        // Background + inset ring so the highlight is visible
                        // around the (semi-transparent during drag) piece.
                        backgroundColor: 'rgb(var(--color-accent) / 0.5)',
                        boxShadow: 'inset 0 0 0 4px rgb(var(--color-accent))',
                        ...(hintSquares[activeSquare] ?? {}),
                      },
                    }
                  : hintSquares,
                arrows: mode === "learn" ? [] : doneArrows,
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
  opening, openingId, mode, summary, rootNode, onRestart,
}: {
  opening: Opening;
  openingId: string;
  mode: PracticeMode;
  summary: SessionSummary;
  rootNode: Node;
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
                  <li key={i} className="bg-bg-surface border border-border rounded-lg px-3 py-2 flex flex-col gap-1">
                    {(() => { const path = mistakeDecisionPath(rootNode, m.nodeId); return path ? <span className="text-content-muted text-xs">{path}</span> : null; })()}
                    <div className="flex items-center gap-2">
                      <span className="text-danger text-sm font-mono">{mistakeMovePrefix(rootNode, m.nodeId)}{m.attemptedSan}</span>
                      <span className="text-content-muted text-xs">→ expected: <span className="text-content-secondary">{m.expectedSans.map(s => `${mistakeMovePrefix(rootNode, m.nodeId)}${s}`).join(' / ') || '—'}</span></span>
                      <div className="flex-1" />
                      <button
                        onClick={() => navigate(`/library/${openingId}?node=${m.nodeId}`)}
                        className="text-accent text-xs hover:underline"
                      >
                        Open
                      </button>
                    </div>
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
                onClick={() => navigate('/review')}
                className="flex-1 py-2 rounded-lg bg-accent text-bg-base font-medium hover:bg-accent-hover"
              >
                Review
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
