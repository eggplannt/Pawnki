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
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { AppShell } from '@/components/AppShell';
import { Chessboard, type ChessboardMove } from '@/components/Chessboard';
import { useColorTheme } from '@/hooks/useColorTheme';
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

type Stage = 'entry' | 'session' | 'done';
type AttemptState =
  | { kind: 'attempting'; wrongCount: number }
  | { kind: 'revealed'; verdict: 'correct' | 'wrong' | 'shown'; wrongCount: number };

interface GradeResult {
  reviewId: string;
  quality: Quality;
  wrongCount: number;
  requeued: boolean;
}

const QUALITIES: Array<{ q: Quality; label: string; desc: string; tone: 'danger' | 'gold' | 'accent' | 'accentBright' }> = [
  { q: 1, label: 'Again', desc: 'Missed it',           tone: 'danger' },
  { q: 2, label: 'Hard',  desc: 'Recalled with effort', tone: 'gold' },
  { q: 4, label: 'Good',  desc: 'Got it',               tone: 'accent' },
  { q: 5, label: 'Easy',  desc: 'Effortless',           tone: 'accentBright' },
];

function toneClasses(tone: 'danger' | 'gold' | 'accent' | 'accentBright') {
  switch (tone) {
    case 'danger':       return { bg: 'bg-danger/15 border-danger/30', text: 'text-danger' };
    case 'gold':         return { bg: 'bg-gold/15 border-gold/30',     text: 'text-gold' };
    case 'accent':       return { bg: 'bg-accent/15 border-accent/30', text: 'text-accent' };
    case 'accentBright': return { bg: 'bg-accent/25 border-accent/40', text: 'text-accent' };
  }
}

export default function ReviewScreen() {
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
      const due = await getDueReviews(await readReviewOrder());
      if (due.length === 0) { await loadEntry(); return; }
      setItems(due);
      setIdx(0);
      setOriginalTotal(due.length);
      setSessionResults([]);
      setSessionError(null);
      setStage('session');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load due reviews');
    } finally {
      setLoading(false);
    }
  }

  // Quality === 1 (Again): don't persist; requeue at end.
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
      setSessionError(e?.message ?? 'Failed to save grade — will retry at end of session');
      setItems((arr) => [...arr, current]);
      setIdx((i) => i + 1);
    }
  }

  if (loading && stage === 'entry') {
    return (
      <AppShell>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      </AppShell>
    );
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
  const router = useRouter();
  const { colors: colorTheme } = useColorTheme();
  const hasDue = (stats?.dueToday ?? 0) > 0;
  return (
    <AppShell>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <View className="flex-row items-center gap-2 mb-1 flex-wrap">
          <MaterialCommunityIcons name="sword-cross" size={22} color={colorTheme.gold.default} />
          <Text className="text-content-primary text-2xl font-semibold">Daily Review</Text>
          {streak && streak.current > 0 && (
            <View
              className={`flex-row items-center gap-1 px-2 py-0.5 rounded-md border ${
                streak.atRisk
                  ? 'bg-gold/15 border-gold/30'
                  : 'bg-accent/15 border-accent/30'
              }`}
            >
              <MaterialCommunityIcons
                name="fire"
                size={12}
                color={streak.atRisk ? colorTheme.gold.default : colorTheme.accent.default}
              />
              <Text
                className="text-xs font-medium"
                style={{ color: streak.atRisk ? colorTheme.gold.default : colorTheme.accent.default }}
              >
                {streak.current} {streak.current === 1 ? 'day' : 'days'}
                {streak.atRisk ? ' · at risk' : ''}
              </Text>
            </View>
          )}
        </View>
        <Text className="text-content-muted text-sm mb-6">
          Spaced repetition over the positions you've learned.
        </Text>

        {error && (
          <View className="mb-4 px-3 py-2 rounded-md bg-danger/15 border border-danger/30">
            <Text className="text-danger text-sm">{error}</Text>
          </View>
        )}

        <View className="flex-row gap-3 mb-8">
          <Metric label="Due today" value={String(stats?.dueToday ?? 0)} accent={hasDue} />
          <Metric label="In repertoire" value={String(stats?.totalLearned ?? 0)} />
          <Metric
            label="Retention"
            value={stats?.retention === null ? '—' : `${stats?.retention ?? 0}%`}
          />
        </View>

        {hasDue ? (
          <Pressable
            onPress={onStart}
            className="bg-accent py-4 rounded-xl items-center active:opacity-80"
          >
            <Text className="text-bg-base font-semibold text-base">
              Start review · {stats!.dueToday} {stats!.dueToday === 1 ? 'position' : 'positions'}
            </Text>
          </Pressable>
        ) : (
          <View className="border border-dashed border-border rounded-xl p-8 items-center">
            <Text className="text-content-primary font-medium mb-1">All caught up</Text>
            <Text className="text-content-muted text-sm text-center">
              {stats?.totalLearned === 0
                ? 'Learn an opening to start collecting reviews.'
                : 'Come back tomorrow to keep your streak going.'}
            </Text>
            <Pressable onPress={() => router.navigate('/library' as any)} className="mt-4">
              <Text className="text-accent text-sm">Go to library →</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </AppShell>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View className="flex-1 bg-bg-surface border border-border rounded-xl p-4">
      <Text className="text-content-muted text-xs uppercase">{label}</Text>
      <Text className={`text-2xl font-semibold mt-1 ${accent ? 'text-accent' : 'text-content-primary'}`}>
        {value}
      </Text>
    </View>
  );
}

// ── Session ───────────────────────────────────────────────────────────────

function ReviewSession({
  item, finalized, originalTotal, sessionError, maxQuality, onClearError, onGraded, onQuit,
}: {
  item: ReviewItem;
  finalized: number;
  originalTotal: number;
  sessionError: string | null;
  /** Ceiling on selectable grade — lowered to the user's previous Miss/Hard
   *  for this position in the current session so retries can't inflate. */
  maxQuality: Quality;
  onClearError: () => void;
  onGraded: (quality: Quality, wrongCount: number) => Promise<void>;
  onQuit: () => void;
}) {
  const { colors: colorTheme } = useColorTheme();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [attempt, setAttempt] = useState<AttemptState>({ kind: 'attempting', wrongCount: 0 });
  const [banner, setBanner] = useState<{ text: string; kind: 'info' | 'err' } | null>(null);
  const [grading, setGrading] = useState(false);
  const [hintLevel, setHintLevel] = useState<0 | 1 | 2>(0);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); }, []);

  const showBanner = useCallback((text: string, kind: 'info' | 'err', timeout = 2000) => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ text, kind });
    bannerTimer.current = setTimeout(() => setBanner(null), timeout);
  }, []);

  const orientation = item.opening.color;
  const boardFen = attempt.kind === 'attempting' ? item.parent.fen : item.node.fen;

  const handleMove = useCallback((move: ChessboardMove): boolean => {
    if (attempt.kind !== 'attempting') return false;
    if (item.acceptedSans.includes(move.san)) {
      const wc = attempt.wrongCount;
      setAttempt({ kind: 'revealed', verdict: wc > 0 ? 'wrong' : 'correct', wrongCount: wc });
      showBanner(wc > 0 ? 'Correct — but you stumbled' : 'Correct', 'info', 800);
      return true;
    }
    setAttempt((a) => a.kind === 'attempting' ? { ...a, wrongCount: a.wrongCount + 1 } : a);
    showBanner('Not quite — try again or use a hint', 'err');
    return false;
  }, [attempt, item, showBanner]);

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
    await onGraded(quality, attempt.wrongCount);
  }, [attempt, grading, onGraded]);

  // Piece highlight on hint level >= 1.
  const hintSquares = useMemo(() => {
    if (hintLevel === 0 || attempt.kind !== 'attempting') return {} as Record<string, StyleProp<ViewStyle>>;
    const styles: Record<string, StyleProp<ViewStyle>> = {};
    for (const sq of item.acceptedFromSquares) {
      styles[sq] = { boxShadow: `inset 0 0 0 3px ${colorTheme.accent.default}` };
    }
    return styles;
  }, [hintLevel, attempt, item, colorTheme]);

  const progressPct = originalTotal === 0 ? 0 : Math.min(100, (finalized / originalTotal) * 100);
  const turnLabel = item.opening.color === 'white' ? 'White to move' : 'Black to move';

  const previews = useMemo(() => {
    const prev = { interval: item.review.interval, ease_factor: item.review.ease_factor, repetitions: item.review.repetitions };
    return new Map<Quality, string>(QUALITIES.map(({ q }) => [q, intervalLabel(applySm2(prev, q).interval)]));
  }, [item.review]);

  const boardSize = Math.min(screenWidth - 24, screenHeight - 420, 500);
  const isWhite = item.opening.color === 'white';

  return (
    <AppShell>
      {/* Header */}
      <View className="flex-row items-center gap-2 px-4 py-2">
        <Pressable
          onPress={() => setConfirmEnd(true)}
          className="w-8 h-8 items-center justify-center rounded-lg active:bg-bg-elevated"
        >
          <MaterialCommunityIcons name="arrow-left" size={20} color={colorTheme.content.muted} />
        </Pressable>
        {/* Opening identity — prominent so transpositions across openings are
            unambiguous about which repertoire to play. */}
        <View
          className={`flex-row items-center gap-1.5 px-2.5 py-1 rounded-md border flex-1 ${
            isWhite ? 'border-gold/40 bg-gold/10' : 'border-accent/40 bg-accent/10'
          }`}
        >
          <MaterialCommunityIcons
            name="chess-king"
            size={16}
            color={isWhite ? colorTheme.gold.default : colorTheme.accent.default}
          />
          <Text className="text-content-primary text-sm font-semibold flex-1" numberOfLines={1}>
            {item.opening.name}
          </Text>
        </View>
        <Text className="text-content-muted text-xs">
          {finalized} / {originalTotal}
        </Text>
      </View>

      {/* Progress bar */}
      <View className="mx-4 h-1 bg-bg-surface rounded-full overflow-hidden">
        <View className="h-full bg-accent" style={{ width: `${progressPct}%` }} />
      </View>

      {/* Prompt row */}
      <View className="flex-row items-center px-4 py-2 min-h-[40px] gap-2">
        <Text className="text-xs text-content-secondary">
          {attempt.kind === 'attempting' ? turnLabel : 'Answer'}
        </Text>
        {attempt.kind === 'attempting' && item.acceptedSans.length > 1 && (
          <Text className="text-xs text-content-muted">
            · {item.acceptedSans.length} valid
          </Text>
        )}
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => setConfirmEnd(true)}
          className="px-2 py-1 rounded-md bg-bg-elevated active:bg-bg-surface border border-border"
        >
          <Text className="text-content-secondary text-xs font-medium">End early</Text>
        </Pressable>
        {attempt.kind === 'attempting' && (
          <Pressable onPress={handleHint} className="px-2 py-1 rounded-md bg-accent/10 active:bg-accent/20">
            <Text className="text-accent text-xs font-medium">
              {hintLevel === 0 ? 'Hint' : 'Show answer'}
            </Text>
          </Pressable>
        )}
      </View>

      {/* Board */}
      <View className="items-center px-3">
        <View style={{ width: boardSize }}>
          <Chessboard
            fen={boardFen}
            orientation={orientation}
            onMove={handleMove}
            disabled={attempt.kind !== 'attempting'}
            squareStyles={hintSquares}
            size={boardSize}
          />
        </View>
      </View>

      {/* Banners */}
      {banner && (
        <View
          className={`mx-4 mt-2 px-3 py-2 rounded-md border ${
            banner.kind === 'err' ? 'bg-danger/15 border-danger/30' : 'bg-bg-elevated border-border'
          }`}
        >
          <Text className={`text-sm ${banner.kind === 'err' ? 'text-danger' : 'text-content-secondary'}`}>
            {banner.text}
          </Text>
        </View>
      )}
      {sessionError && (
        <View className="mx-4 mt-2 px-3 py-2 rounded-md border bg-danger/15 border-danger/30 flex-row items-center gap-2">
          <Text className="text-danger text-sm flex-1">{sessionError}</Text>
          <Pressable onPress={onClearError}>
            <Text className="text-danger text-xs underline">dismiss</Text>
          </Pressable>
        </View>
      )}

      {/* Answer label */}
      {attempt.kind === 'revealed' && (
        <View className="mx-4 mt-2">
          <View className="flex-row items-center gap-2">
            <Text className="text-content-muted text-sm">Answer:</Text>
            <Text className="text-content-primary text-sm font-semibold font-mono">{item.node.move_san}</Text>
            {attempt.verdict === 'correct' && <Text className="text-accent text-xs">✓ first try</Text>}
            {attempt.verdict === 'wrong' && <Text className="text-danger text-xs">missed</Text>}
            {attempt.verdict === 'shown' && <Text className="text-content-muted text-xs">revealed</Text>}
          </View>
          {item.node.annotation && (
            <Text className="text-content-secondary text-sm mt-1">{item.node.annotation}</Text>
          )}
        </View>
      )}

      {/* Grade buttons */}
      {attempt.kind === 'revealed' && (
        <View className="mx-4 mt-3">
          {maxQuality < 5 && (
            <Text className="text-content-muted text-xs mb-2">
              You previously {maxQuality === 1 ? 'missed' : 'struggled with'} this position — grades above that are locked for this session.
            </Text>
          )}
          <View className="flex-row gap-2">
            {QUALITIES.map(({ q, label, desc, tone }) => {
              const lockedByCap = q > maxQuality;
              const disabled = grading || lockedByCap;
              const tc = toneClasses(tone);
              return (
                <Pressable
                  key={q}
                  onPress={() => handleGrade(q)}
                  disabled={disabled}
                  className={`flex-1 px-2 py-3 rounded-lg border items-center ${tc.bg} ${disabled ? 'opacity-30' : 'active:opacity-80'}`}
                >
                  <Text className={`text-sm font-medium ${tc.text}`}>{label}</Text>
                  <Text className={`text-[10px] opacity-75 ${tc.text}`}>{previews.get(q)}</Text>
                  <Text className={`text-[10px] opacity-60 ${tc.text}`}>{desc}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      <Modal
        visible={confirmEnd}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmEnd(false)}
      >
        <Pressable
          onPress={() => setConfirmEnd(false)}
          className="flex-1 items-center justify-center bg-black/60 px-4"
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="bg-bg-elevated border border-border rounded-xl p-6 w-full max-w-sm"
          >
            <Text className="text-content-primary font-semibold mb-1">End review?</Text>
            <Text className="text-content-muted text-sm mb-4">
              <Text className="text-accent font-medium">{finalized}</Text>
              <Text>{' '}position{finalized === 1 ? '' : 's'} graded and saved. </Text>
              <Text className="text-content-secondary">{Math.max(0, originalTotal - finalized)}</Text>
              <Text>{' '}left — they'll come back next time.</Text>
            </Text>
            <View className="flex-row gap-2">
              <Pressable
                onPress={() => setConfirmEnd(false)}
                className="flex-1 py-3 rounded-lg border border-border items-center active:bg-bg-surface"
              >
                <Text className="text-content-secondary text-sm">Keep going</Text>
              </Pressable>
              <Pressable
                onPress={() => { setConfirmEnd(false); onQuit(); }}
                className="flex-1 py-3 rounded-lg bg-accent items-center active:opacity-80"
              >
                <Text className="text-bg-base text-sm font-medium">End now</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </AppShell>
  );
}

// ── Done ──────────────────────────────────────────────────────────────────

function DoneScreen({
  results, originalTotal, streak, onBack,
}: { results: GradeResult[]; originalTotal: number; streak: Streak | null; onBack: () => void }) {
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
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text className="text-content-primary text-2xl font-semibold mb-1">Review complete</Text>
        <Text className="text-content-muted text-sm mb-6">
          {originalTotal} {originalTotal === 1 ? 'position' : 'positions'} reviewed.
          {streakValue > 0 && (
            <Text className="text-accent font-medium">
              {' '}{streakValue}-day streak {streakValue === 1 ? 'started' : 'kept alive'}.
            </Text>
          )}
        </Text>

        <View className="flex-row gap-3 mb-6">
          <Metric label="First try" value={`${firstTry}`} accent={firstTry > 0} />
          <Metric label="Requeued" value={`${requeues}`} />
          <Metric label="Accuracy" value={originalTotal === 0 ? '—' : `${Math.round((firstTry / originalTotal) * 100)}%`} />
        </View>

        <Pressable onPress={onBack} className="py-3 rounded-lg bg-accent items-center active:opacity-80">
          <Text className="text-bg-base text-sm font-medium">Done</Text>
        </Pressable>
      </ScrollView>
    </AppShell>
  );
}
