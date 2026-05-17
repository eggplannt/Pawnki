import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Modal,
  useWindowDimensions,
  ViewStyle,
  StyleProp,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getOpening, getNodes, buildTree } from '@/lib/openings';
import { getLearnedNodeIds, markPositionsLearned } from '@/lib/reviews';
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
import { Chessboard, type ChessboardMove } from '@/components/Chessboard';
import { useColorTheme } from '@/hooks/useColorTheme';
import type { Node, Opening } from '@/types';

const OPPONENT_DELAY_MS = 300;

/**
 * Learn mode: walk forward through every move that would otherwise auto-play
 * (opponent replies + user moves the user already knows or forced non-teaching
 * choices) until we hit a stop — teaching move, real branching decision,
 * completion, or backtrack-stuck. Returns the final session + step count.
 */
function fastForwardLearn(start: PracticeSession): { session: PracticeSession; steps: number } {
  let cur = start;
  let steps = 0;
  while (steps < 256) {
    if (cur.status === 'complete') break;
    if (cur.status === 'opponent-to-move') {
      const next = opponentMove(cur).session;
      if (next === cur || next.currentNode.id === cur.currentNode.id) break;
      cur = next;
      steps++;
      continue;
    }
    const applicable = applicableChildren(cur);
    if (applicable.length !== 1) break;
    const target = applicable[0];
    const targetLearnable = cur.learnableMap.get(target.id) ?? false;
    const isTeaching = targetLearnable && !cur.options.learnedNodeIds.has(target.id);
    if (isTeaching) break;
    const san = target.move_san;
    if (!san) break;
    const next = attemptMove(cur, san).session;
    if (next === cur || next.currentNode.id === cur.currentNode.id) break;
    cur = next;
    steps++;
  }
  return { session: cur, steps };
}

function findNodeById(root: Node, id: string): Node | null {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const f = findNodeById(c, id);
    if (f) return f;
  }
  return null;
}

export default function PracticeScreen() {
  const { colors: colorTheme } = useColorTheme();
  const params = useLocalSearchParams<{ id: string; mode?: string; from?: string }>();
  const id = params.id;
  const mode = (params.mode as PracticeMode) ?? 'learn';
  const fromNodeId = params.from;
  const router = useRouter();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [banner, setBanner] = useState<{ text: string; kind: 'info' | 'warn' | 'err' } | null>(null);
  const [revealedSans, setRevealedSans] = useState<string[] | null>(null);
  const [hintSquares, setHintSquares] = useState<Record<string,StyleProp<ViewStyle>>>({});
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [savingFinalize, setSavingFinalize] = useState(false);
  const [confirmEndEarly, setConfirmEndEarly] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────────

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
        const [op, nodes, learned] = await Promise.all([
          getOpening(id),
          getNodes(id),
          getLearnedNodeIds(id),
        ]);
        if (cancelled) return;
        const tree = buildTree(nodes);
        if (!tree) { setError('Opening has no moves yet.'); setLoading(false); return; }
        const rootNode = fromNodeId ? findNodeById(tree, fromNodeId) ?? tree : tree;
        setOpening(op);
        setSession(startSession({ mode, userColor: op.color, rootNode, learnedNodeIds: learned }));
        setLoading(false);
      } catch (e: any) {
        if (!cancelled) { setError(e?.message ?? 'Failed to start'); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [id, mode, fromNodeId, reloadKey]);

  // ── Banner ────────────────────────────────────────────────────────────────

  const showBanner = useCallback((text: string, kind: 'info' | 'warn' | 'err', timeout = 2500) => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ text, kind });
    bannerTimer.current = setTimeout(() => setBanner(null), timeout);
  }, []);

  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); }, []);

  // ── Auto-advance (opponent + learn-mode auto-skip) ────────────────────────
  //
  // Practice mode: one opponent move at a time with a 300ms animation delay.
  //
  // Learn mode: collapse the chain of auto-played moves (opponent replies +
  // known/forced user moves) into a single transition. If exactly one move
  // separates the current position from the next teaching/decision stop, we
  // animate it. If two or more — e.g. opponent reply + walked-through known
  // line, or a long jump back into another subtree after backtracking — we
  // jump straight to the next stop without animating intermediate steps.
  useEffect(() => {
    if (!session || session.status === 'complete') return;

    if (session.options.mode === 'practice') {
      if (session.status !== 'opponent-to-move') return;
      const t = setTimeout(() => {
        setSession((s) => (s && s.status === 'opponent-to-move' ? opponentMove(s).session : s));
      }, OPPONENT_DELAY_MS);
      return () => clearTimeout(t);
    }

    const { session: target, steps } = fastForwardLearn(session);
    if (steps === 0) return;
    if (steps === 1) {
      const t = setTimeout(() => setSession(target), OPPONENT_DELAY_MS);
      return () => clearTimeout(t);
    }
    setSession(target);
  }, [session?.status, session?.currentNode.id]);

  // ── Finalize on complete ─────────────────────────────────────────────────

  useEffect(() => {
    if (!session || session.status !== 'complete' || summary || savingFinalize) return;
    setSavingFinalize(true);
    const s = finalize(session);
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
  }, [session?.status]);

  // Reset reveal on advance
  useEffect(() => { 
    setHintSquares({});
    setRevealedSans(null); 
  }, [session?.currentNode.id]);

  // ── Move handler ──────────────────────────────────────────────────────────

  const handleMove = useCallback((move: ChessboardMove): boolean => {
    if (!session || session.status !== 'awaiting-user') return false;
    const out = attemptMove(session, move.san);
    setSession(out.session);
    if (out.verdict === 'correct') {
      if (mode === 'learn' && session.wrongAttemptsHere > 0) {
        showBanner('Correct — but you stumbled. We\'ll re-ask this at the end.', 'info', 3500);
      }
      else showBanner('Correct', 'info', 500);
    } else if (out.verdict === 'wrong') {
      showBanner(out.reason ?? 'Wrong move.', 'err');
    } else if (out.verdict === 'wrong-disallowed') {
      showBanner(out.reason ?? 'Already practiced.', 'info');
    } else if (out.verdict === 'wrong-mode') {
      showBanner(out.reason ?? 'Not allowed in this mode.', 'warn');
    }
    return out.verdict === 'correct';
  }, [session, showBanner]);

  const handleHint = useCallback(() => {
    if (!session || session.status !== 'awaiting-user') return;
    const nextLevel: 1 | 2 = session.hintLevel === 0 ? 1 : 2;
    const { session: next, hint } = showHint(session, nextLevel);
    setSession(next);
    if (nextLevel === 1) {
      const styles: Record<string, StyleProp<ViewStyle>> = {};
      for (const sq of hint.fromSquares) {
        styles[sq] = { boxShadow: `inset 0 0 0 3px ${colorTheme.accent.default}` };
      }
      setHintSquares(styles);
    } else if (nextLevel === 2 && hint.sans) {
      setRevealedSans(hint.sans);
    }
    if (hint.sans) setRevealedSans(hint.sans);
  }, [session]);

  // ── End early ────────────────────────────────────────────────────────────
  // Stop now; the completion effect saves `firstTryCorrect` as review_cards.

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

  const choiceCount = useMemo(() => {
    if (!session || session.status !== 'awaiting-user') return 0;
    return applicableChildren(session).length;
  }, [session]);

  // Draw a "danger arrow" from→to on the board for each child that's already
  // done this session (or whose subtree has nothing left applicable), so the
  // user is steered away from picking it again.
  const doneArrows = useMemo(() => {
    const out: Array<{ from: string; to: string }> = [];
    if (!session || session.status !== 'awaiting-user') return out;
    const userIsToMove = session.currentNode.fen.split(' ')[1] === (session.options.userColor === 'white' ? 'w' : 'b');
    if (!userIsToMove) return out;
    for (const c of session.currentNode.children ?? []) {
      const uci = c.move_uci ?? '';
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      if (!from || !to) continue;
      const practiced = session.practicedChildIds.has(c.id);
      const exhausted = (session.applicableCounts.get(c.id) ?? 0) === 0;
      if (practiced || exhausted) out.push({ from, to });
    }
    return out;
  }, [session]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-bg-base items-center justify-center">
        <ActivityIndicator color={colorTheme.accent.default} />
      </SafeAreaView>
    );
  }
  if (error || !session || !opening) {
    return (
      <SafeAreaView className="flex-1 bg-bg-base p-6">
        <Text className="text-content-muted">{error ?? 'Could not start session.'}</Text>
        <Pressable onPress={() => router.back()} className="mt-2">
          <Text className="text-accent text-sm">Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (summary) {
    return (
      <SummaryScreen
        opening={opening}
        openingId={id}
        mode={mode}
        summary={summary}
        onRestart={() => setReloadKey((k) => k + 1)}
        onPractice={() => {
          setSummary(null);
          router.replace({ pathname: '/practice/[id]', params: { id, mode: 'practice' } } as any);
        }}
        onDone={() => router.back()}
        onOpenMistake={(nodeId) =>
          router.navigate({ pathname: '/opening/[id]', params: { id, node: nodeId } } as any)
        }
      />
    );
  }

  const boardSize = Math.min(screenWidth - 24, screenHeight - 360, 500);
  const isLearn = mode === 'learn';

  return (
    <SafeAreaView className="flex-1 bg-bg-base">
      {/* Header */}
      <View className="flex-row items-center gap-2 px-4 py-2">
        <Pressable
          onPress={isLearn && session.status !== 'complete' ? handleEndEarly : () => router.back()}
          className="w-8 h-8 items-center justify-center rounded-lg active:bg-bg-elevated"
        >
          <MaterialCommunityIcons name="arrow-left" size={20} color={colorTheme.content.muted} />
        </Pressable>
        <View
          className={`px-2 py-0.5 rounded ${isLearn ? 'bg-accent/15' : 'bg-gold/15'}`}
        >
          <Text className={`text-xs font-medium ${isLearn ? 'text-accent' : 'text-gold'}`}>
            {isLearn ? 'Learn' : 'Practice'}
          </Text>
        </View>
        {session.phase === 'requeue' && (
          <View className="px-2 py-0.5 rounded bg-gold/15">
            <Text className="text-gold text-xs font-medium">Re-prompt · {session.requeueEntries.length}</Text>
          </View>
        )}
        <Text className="text-content-primary text-base font-semibold flex-1" numberOfLines={1}>
          {opening.name}
        </Text>
        <Text className="text-content-muted text-xs">
          {session.completedApplicable} / {session.totalApplicable}
        </Text>
      </View>

      {/* Progress */}
      <View className="mx-4 h-1 bg-bg-surface rounded-full overflow-hidden">
        <View
          className={`h-full ${isLearn ? 'bg-accent' : 'bg-gold'}`}
          style={{ width: session.totalApplicable === 0 ? '0%' : `${(session.completedApplicable / session.totalApplicable) * 100}%` }}
        />
      </View>

      {/* Status row */}
      <View className="flex-row items-center px-4 py-2 min-h-[40px]">
        {session.status === 'awaiting-user' && choiceCount > 1 && (
          <Text className="text-xs text-content-secondary">{choiceCount} choices</Text>
        )}
        {session.status === 'opponent-to-move' && (
          <Text className="text-xs text-content-muted italic">...</Text>
        )}
        <View style={{ flex: 1 }} />
        {isLearn && session.status !== 'complete' && (
          <Pressable
            onPress={handleEndEarly}
            className="px-2 py-1 mr-2 rounded-md bg-bg-elevated active:bg-bg-surface border border-border"
          >
            <Text className="text-content-secondary text-xs font-medium">End early</Text>
          </Pressable>
        )}
        {session.status === 'awaiting-user' && session.hintLevel < 2 && (
          <Pressable onPress={handleHint} className="px-2 py-1 rounded-md bg-accent/10 active:bg-accent/20">
            <Text className="text-accent text-xs font-medium">
              {session.hintLevel === 0 ? 'Hint' : 'Show answer'}
            </Text>
          </Pressable>
        )}
      </View>


      {/* Board */}
      <View className="items-center px-3">
        <View style={{ width: boardSize }}>
          <Chessboard
            fen={session.currentNode.fen}
            orientation={opening.color}
            onMove={handleMove}
            disabled={session.status !== 'awaiting-user'}
            squareStyles={hintSquares}
            size={boardSize}
            arrows={ mode == 'learn' ? [] : doneArrows}
          />
        </View>
      </View>

      {/* Banners */}
      {banner && (
        <View
          className={`mx-4 mt-2 px-3 py-2 rounded-md border ${
            banner.kind === 'err' ? 'bg-danger/15 border-danger/30' :
            banner.kind === 'warn' ? 'bg-gold/15 border-gold/30' :
            'bg-bg-elevated border-border'
          }`}
        >
          <Text
            className={`text-sm ${
              banner.kind === 'err' ? 'text-danger' :
              banner.kind === 'warn' ? 'text-gold' :
              'text-content-secondary'
            }`}
          >
            {banner.text}
          </Text>
        </View>
      )}
      {revealedSans && revealedSans.length > 0 && (
        <View className="mx-4 mt-2 px-3 py-2 rounded-md bg-accent/10 border border-accent/20">
          <Text className="text-accent text-sm">Answer: {revealedSans.join(' or ')}</Text>
        </View>
      )}

      <Modal
        visible={confirmEndEarly && !!endEarlyStats}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmEndEarly(false)}
      >
        <Pressable
          onPress={() => setConfirmEndEarly(false)}
          className="flex-1 items-center justify-center bg-black/60 px-4"
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="bg-bg-elevated border border-border rounded-xl p-6 w-full max-w-sm"
          >
            <Text className="text-content-primary font-semibold mb-1">End learning early?</Text>
            <Text className="text-content-muted text-sm mb-4">
              <Text className="text-accent font-medium">{endEarlyStats?.learnedNow ?? 0}</Text>
              <Text>{' '}position{(endEarlyStats?.learnedNow ?? 0) === 1 ? '' : 's'} you got on the first try will be marked learned.</Text>
              {(endEarlyStats?.remaining ?? 0) > 0 && (
                <>
                  <Text>{' '}</Text>
                  <Text className="text-content-secondary">{endEarlyStats?.remaining}</Text>
                  <Text>{' '}position{(endEarlyStats?.remaining ?? 0) === 1 ? '' : 's'} will remain unlearned for next time.</Text>
                </>
              )}
            </Text>
            <View className="flex-row gap-2">
              <Pressable
                onPress={() => setConfirmEndEarly(false)}
                className="flex-1 py-3 rounded-lg border border-border items-center active:bg-bg-surface"
              >
                <Text className="text-content-secondary text-sm">Keep going</Text>
              </Pressable>
              <Pressable
                onPress={confirmEnd}
                className="flex-1 py-3 rounded-lg bg-accent items-center active:opacity-80"
              >
                <Text className="text-bg-base text-sm font-medium">End now</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

// ── Summary ────────────────────────────────────────────────────────────────

function SummaryScreen({
  opening, mode, summary, onRestart, onPractice, onDone, onOpenMistake,
}: {
  opening: Opening;
  openingId: string;
  mode: PracticeMode;
  summary: SessionSummary;
  onRestart: () => void;
  onPractice: () => void;
  onDone: () => void;
  onOpenMistake: (nodeId: string) => void;
}) {
  const endedEarly = mode === 'learn' && summary.completedApplicable < summary.totalApplicable;
  return (
    <SafeAreaView className="flex-1 bg-bg-base">
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Pressable onPress={onDone}>
          <Text className="text-accent text-sm">← Back to opening</Text>
        </Pressable>
        <Text className="text-content-primary text-2xl font-semibold mt-3 mb-1">
          {mode === 'learn' ? 'Learning session complete' : 'Practice session complete'}
        </Text>
        <Text className="text-content-muted text-sm mb-6">{opening.name}</Text>

        <View className="flex-row gap-3 mb-6">
          <Stat label="Completed" value={`${summary.completedApplicable} / ${summary.totalApplicable}`} tone="ok" />
          <Stat label="Mistakes" value={String(summary.mistakes.length)} tone={summary.mistakes.length > 0 ? 'err' : 'ok'} />
          <Stat label="Hinted" value={String(summary.hintedNodeIds.length)} tone="info" />
        </View>

        {summary.mistakes.length > 0 && (
          <>
            <Text className="text-content-primary text-base font-semibold mb-2">Mistakes</Text>
            <View className="gap-2 mb-6">
              {summary.mistakes.map((m, i) => (
                <View key={i} className="bg-bg-surface border border-border rounded-lg px-3 py-2 flex-row items-center gap-2">
                  <Text className="text-danger text-sm font-mono">{m.attemptedSan}</Text>
                  <Text className="text-content-muted text-xs flex-1">
                    → expected: <Text className="text-content-secondary">{m.expectedSans.join(' / ') || '—'}</Text>
                  </Text>
                  <Pressable onPress={() => onOpenMistake(m.nodeId)}>
                    <Text className="text-accent text-xs">Open</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </>
        )}

        <View className="flex-row gap-2">
          <Pressable onPress={onDone} className="flex-1 py-3 rounded-lg border border-border items-center">
            <Text className="text-content-secondary text-sm">Done</Text>
          </Pressable>
          <Pressable
            onPress={endedEarly ? onRestart : (mode === 'practice' ? onRestart : onPractice)}
            className="flex-1 py-3 rounded-lg bg-accent items-center"
          >
            <Text className="text-bg-base text-sm font-medium">
              {endedEarly ? 'Keep learning' : mode === 'learn' ? 'Practice more' : 'Practice again'}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'err' | 'info' }) {
  const toneCls = tone === 'ok' ? 'text-accent' : tone === 'err' ? 'text-danger' : 'text-gold';
  return (
    <View className="flex-1 bg-bg-surface border border-border rounded-lg p-3">
      <Text className="text-content-muted text-xs uppercase">{label}</Text>
      <Text className={`text-xl font-semibold mt-0.5 ${toneCls}`}>{value}</Text>
    </View>
  );
}
