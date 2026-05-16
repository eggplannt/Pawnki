import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
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
import { Chessboard, type ChessboardMove } from '@/components/Chessboard';
import { colorTheme } from '@/hooks/useColorTheme';
import type { Node, Opening } from '@/types';

const OPPONENT_DELAY_MS = 300;

function findNodeById(root: Node, id: string): Node | null {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const f = findNodeById(c, id);
    if (f) return f;
  }
  return null;
}

export default function PracticeScreen() {
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
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [savingFinalize, setSavingFinalize] = useState(false);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
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
  }, [id, mode, fromNodeId]);

  // ── Banner ────────────────────────────────────────────────────────────────

  const showBanner = useCallback((text: string, kind: 'info' | 'warn' | 'err') => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ text, kind });
    bannerTimer.current = setTimeout(() => setBanner(null), 2500);
  }, []);

  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); }, []);

  // ── Opponent auto-play ────────────────────────────────────────────────────

  useEffect(() => {
    if (!session || session.status !== 'opponent-to-move') return;
    const t = setTimeout(() => {
      setSession((s) => {
        if (!s || s.status !== 'opponent-to-move') return s;
        return opponentMove(s).session;
      });
    }, OPPONENT_DELAY_MS);
    return () => clearTimeout(t);
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
        if (toInsert.length > 0) await insertReviewCards(toInsert);
      } catch (e: any) {
        showBanner(`Couldn't save progress: ${e?.message ?? e}`, 'err');
      } finally {
        setSummary(s);
        setSavingFinalize(false);
      }
    })();
  }, [session?.status]);

  // Reset reveal on advance
  useEffect(() => { setRevealedSans(null); }, [session?.currentNode.id]);

  // ── Move handler ──────────────────────────────────────────────────────────

  const handleMove = useCallback((move: ChessboardMove) => {
    if (!session || session.status !== 'awaiting-user') return;
    const out = attemptMove(session, move.san);
    setSession(out.session);
    if (out.verdict === 'correct') {
      // silent
    } else if (out.verdict === 'wrong') {
      showBanner(out.reason ?? 'Wrong move.', 'err');
    } else if (out.verdict === 'wrong-disallowed') {
      showBanner(out.reason ?? 'Already practiced.', 'info');
    } else if (out.verdict === 'wrong-mode') {
      showBanner(out.reason ?? 'Not allowed in this mode.', 'warn');
    }
  }, [session, showBanner]);

  const handleHint = useCallback(() => {
    if (!session || session.status !== 'awaiting-user') return;
    const { session: next, hint } = showHint(session, 2);
    setSession(next);
    if (hint.sans) setRevealedSans(hint.sans);
  }, [session]);

  const choiceCount = useMemo(() => {
    if (!session || session.status !== 'awaiting-user') return 0;
    return applicableChildren(session).length;
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
        onAgain={() => {
          setSummary(null);
          router.replace({ pathname: '/practice/[id]', params: { id, mode } } as any);
        }}
        onDone={() => router.replace({ pathname: '/opening/[id]', params: { id } } as any)}
        onOpenMistake={(nodeId) =>
          router.replace({ pathname: '/opening/[id]', params: { id, node: nodeId } } as any)
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
        <Pressable onPress={() => router.back()} className="w-8 h-8 items-center justify-center rounded-lg active:bg-bg-elevated">
          <MaterialCommunityIcons name="arrow-left" size={20} color={colorTheme.content.muted} />
        </Pressable>
        <View
          className={`px-2 py-0.5 rounded ${isLearn ? 'bg-accent/15' : 'bg-gold/15'}`}
        >
          <Text className={`text-xs font-medium ${isLearn ? 'text-accent' : 'text-gold'}`}>
            {isLearn ? 'Learn' : 'Practice'}
          </Text>
        </View>
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
      <View className="flex-row items-center px-4 py-2 min-h-[28px]">
        {session.status === 'awaiting-user' && choiceCount > 1 && (
          <Text className="text-xs text-content-secondary">{choiceCount} choices</Text>
        )}
        {session.status === 'opponent-to-move' && (
          <Text className="text-xs text-content-muted italic">Opponent is moving…</Text>
        )}
        <View style={{ flex: 1 }} />
        {session.status === 'awaiting-user' && (
          <Pressable onPress={handleHint} className="px-2 py-1 rounded-md bg-accent/10 active:bg-accent/20">
            <Text className="text-accent text-xs font-medium">Hint</Text>
          </Pressable>
        )}
      </View>

      {/* Banners */}
      {banner && (
        <View
          className={`mx-4 mb-2 px-3 py-2 rounded-md border ${
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
        <View className="mx-4 mb-2 px-3 py-2 rounded-md bg-accent/10 border border-accent/20">
          <Text className="text-accent text-sm">Answer: {revealedSans.join(' or ')}</Text>
        </View>
      )}

      {/* Board */}
      <View className="items-center px-3">
        <View style={{ width: boardSize }}>
          <Chessboard
            fen={session.currentNode.fen}
            orientation={opening.color}
            onMove={handleMove}
            disabled={session.status !== 'awaiting-user'}
          />
        </View>
      </View>

      {/* Last move */}
      {session.currentNode.move_san && (
        <View className="px-4 py-2 items-center">
          <Text className="text-content-secondary text-sm">
            Last move: <Text className={`font-medium ${isLearn ? 'text-accent' : 'text-gold'}`}>{session.currentNode.move_san}</Text>
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

// ── Summary ────────────────────────────────────────────────────────────────

function SummaryScreen({
  opening, openingId, mode, summary, onAgain, onDone, onOpenMistake,
}: {
  opening: Opening;
  openingId: string;
  mode: PracticeMode;
  summary: SessionSummary;
  onAgain: () => void;
  onDone: () => void;
  onOpenMistake: (nodeId: string) => void;
}) {
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
          <Pressable onPress={onAgain} className="flex-1 py-3 rounded-lg bg-accent items-center">
            <Text className="text-bg-base text-sm font-medium">
              {mode === 'learn' ? 'Learn again' : 'Practice again'}
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
