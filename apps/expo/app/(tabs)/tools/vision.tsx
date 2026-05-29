import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  Dimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppShell } from '@/components/AppShell';
import { Chessboard } from '@/components/Chessboard';
import { useColorTheme, type ColorTheme } from '@/hooks/useColorTheme';
import {
  buildScene,
  buildMovePreview,
  generateStaticQuestions,
  gradeAnswer,
  pickNextMove,
  type MovePreview,
  type AnswerVerdict,
  type VisionQuestion,
  type Scene,
} from '@pawnki/shared';

// ── Phase machine (mirrors apps/web/src/pages/VisionTrainer.tsx) ──────────
//
// A "batch" is one full cycle of training between board applications:
//   cycle 1: move M1 announced, then questions about visible + M1
//   cycle 2: move M2 announced, then questions about visible + M1 + M2
//   ... up to cycle = depth ...
//   review: board catches up by applying M1..Mdepth.
//
// The board never updates between cycle 0 and review. The visualized moves
// accumulate in the imaginedFen used to generate questions; the visible board
// stays on the original FEN so the player must hold the changes in memory.

type BoardOrientation = 'w' | 'b';

type SetupPhase = {
  kind: 'setup';
  depthDraft: number;
  questionsDraft: number;
  orientationDraft: BoardOrientation;
  showCoordsDraft: boolean;
  showAnnounceIndicatorsDraft: boolean;
  showQuestionFocusDraft: boolean;
};

type StaticPhase = {
  kind: 'static';
  visibleFen: string;
  imaginedFen: string;
  visualizedMoves: MovePreview[];
  cycleIndex: number;
  depth: number;
  questions: VisionQuestion[];
  qIndex: number;
  selected: Set<string>;
  verdict: AnswerVerdict | null;
  peeking: boolean;
};

type AnnouncePhase = {
  kind: 'announce';
  visibleFen: string;
  visualizedMoves: MovePreview[];
  announcement: MovePreview;
  cycleIndex: number;
  depth: number;
};

type ReviewPhase = {
  kind: 'review';
  finalFen: string;
  visualizedMoves: MovePreview[];
  depth: number;
};

type Phase =
  | SetupPhase
  | { kind: 'loading'; message: string }
  | StaticPhase
  | AnnouncePhase
  | ReviewPhase
  | { kind: 'end' };

type Score = {
  questionsAnswered: number;
  correctSquares: number;
  missedSquares: number;
  wrongSquares: number;
  perfectAnswers: number;
};

const EMPTY_SCORE: Score = {
  questionsAnswered: 0,
  correctSquares: 0,
  missedSquares: 0,
  wrongSquares: 0,
  perfectAnswers: 0,
};

function accumulateScore(s: Score, v: AnswerVerdict): Score {
  return {
    questionsAnswered: s.questionsAnswered + 1,
    correctSquares: s.correctSquares + v.correct.length,
    missedSquares: s.missedSquares + v.missed.length,
    wrongSquares: s.wrongSquares + v.wrong.length,
    perfectAnswers: s.perfectAnswers + (v.isPerfect ? 1 : 0),
  };
}

const MAX_BATCHES_PER_POSITION = 3;
const DEFAULT_DEPTH = 3;
const DEFAULT_QUESTIONS_PER_ROUND = 3;
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 10;
const MIN_DEPTH = 1;
const MAX_DEPTH = 50;

const DEPTH_STORAGE_KEY = 'pawnki-vision-depth';
const QUESTIONS_STORAGE_KEY = 'pawnki-vision-questions';
const ORIENTATION_STORAGE_KEY = 'pawnki-vision-orientation';
const COORDS_STORAGE_KEY = 'pawnki-vision-coords';
const ANNOUNCE_IND_STORAGE_KEY = 'pawnki-vision-announce-ind';
const QUESTION_FOCUS_STORAGE_KEY = 'pawnki-vision-question-focus';

function clampToRange(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function withAlpha(rgbString: string, alpha: number): string {
  // The theme exposes colors as `rgb(R, G, B)`. Rewrite to `rgba(R, G, B, a)`.
  return rgbString.replace(/^rgb\(/, 'rgba(').replace(/\)$/, `, ${alpha})`);
}

// ── Component ─────────────────────────────────────────────────────────────
export default function VisionTrainerScreen() {
  const router = useRouter();
  const { colors: colorTheme } = useColorTheme();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading', message: 'Loading…' });
  const [score, setScore] = useState<Score>(EMPTY_SCORE);
  const [openingName, setOpeningName] = useState<string>('');
  const [positionCount, setPositionCount] = useState(0);

  const sceneRef = useRef<Scene | null>(null);
  const batchesOnSceneRef = useRef(0);
  const depthRef = useRef(DEFAULT_DEPTH);
  const questionsPerRoundRef = useRef(DEFAULT_QUESTIONS_PER_ROUND);
  const orientationRef = useRef<BoardOrientation>('w');
  const showCoordsRef = useRef<boolean>(false);
  const showAnnounceIndicatorsRef = useRef<boolean>(false);
  const showQuestionFocusRef = useRef<boolean>(false);

  // Rolling-window exclusion (matches web behavior).
  const recentAskedRef = useRef<Map<string, number>>(new Map());
  const absMoveRef = useRef(0);

  // ── Preferences load (async, one-shot) ────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [d, q, o, c, ai, qf] = await Promise.all([
          AsyncStorage.getItem(DEPTH_STORAGE_KEY),
          AsyncStorage.getItem(QUESTIONS_STORAGE_KEY),
          AsyncStorage.getItem(ORIENTATION_STORAGE_KEY),
          AsyncStorage.getItem(COORDS_STORAGE_KEY),
          AsyncStorage.getItem(ANNOUNCE_IND_STORAGE_KEY),
          AsyncStorage.getItem(QUESTION_FOCUS_STORAGE_KEY),
        ]);
        const depthDraft = clampToRange(parseInt(d ?? '', 10) || DEFAULT_DEPTH, MIN_DEPTH, MAX_DEPTH);
        const questionsDraft = clampToRange(parseInt(q ?? '', 10) || DEFAULT_QUESTIONS_PER_ROUND, MIN_QUESTIONS, MAX_QUESTIONS);
        const orientationDraft: BoardOrientation = o === 'b' ? 'b' : 'w';
        const showCoordsDraft = c === '1';
        const showAnnounceIndicatorsDraft = ai === '1';
        const showQuestionFocusDraft = qf === '1';
        setPhase({
          kind: 'setup',
          depthDraft, questionsDraft, orientationDraft, showCoordsDraft,
          showAnnounceIndicatorsDraft, showQuestionFocusDraft,
        });
      } catch {
        setPhase({
          kind: 'setup',
          depthDraft: DEFAULT_DEPTH,
          questionsDraft: DEFAULT_QUESTIONS_PER_ROUND,
          orientationDraft: 'w',
          showCoordsDraft: false,
          showAnnounceIndicatorsDraft: false,
          showQuestionFocusDraft: false,
        });
      }
    })();
  }, []);

  // ── Session entry points ──────────────────────────────────────────────
  async function handleStartSession() {
    if (phase.kind !== 'setup') return;
    const depth = phase.depthDraft;
    const qpr = phase.questionsDraft;
    const orientation = phase.orientationDraft;
    const showCoords = phase.showCoordsDraft;
    const announceInd = phase.showAnnounceIndicatorsDraft;
    const questionFocus = phase.showQuestionFocusDraft;
    try {
      await Promise.all([
        AsyncStorage.setItem(DEPTH_STORAGE_KEY, String(depth)),
        AsyncStorage.setItem(QUESTIONS_STORAGE_KEY, String(qpr)),
        AsyncStorage.setItem(ORIENTATION_STORAGE_KEY, orientation),
        AsyncStorage.setItem(COORDS_STORAGE_KEY, showCoords ? '1' : '0'),
        AsyncStorage.setItem(ANNOUNCE_IND_STORAGE_KEY, announceInd ? '1' : '0'),
        AsyncStorage.setItem(QUESTION_FOCUS_STORAGE_KEY, questionFocus ? '1' : '0'),
      ]);
    } catch { /* persisting prefs is best-effort */ }
    depthRef.current = depth;
    questionsPerRoundRef.current = qpr;
    orientationRef.current = orientation;
    showCoordsRef.current = showCoords;
    showAnnounceIndicatorsRef.current = announceInd;
    showQuestionFocusRef.current = questionFocus;
    recentAskedRef.current = new Map();
    absMoveRef.current = 0;
    setScore(EMPTY_SCORE);
    setPositionCount(0);
    setPhase({ kind: 'loading', message: 'Loading position…' });
    setTimeout(() => loadNewPosition(), 0);
  }

  const loadNewPosition = useCallback(() => {
    const scene = buildScene();
    sceneRef.current = scene;
    batchesOnSceneRef.current = 0;
    setOpeningName(scene.source);
    setPositionCount((p) => p + 1);
    startBatch(scene.fen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startBatch(fen: string) {
    announceNextMove(fen, fen, [], 1);
  }

  function announceNextMove(
    visibleFen: string,
    workingFen: string,
    visualizedMoves: MovePreview[],
    nextCycleIndex: number,
  ) {
    const scene = sceneRef.current;
    if (!scene) { loadNewPosition(); return; }
    const uci = pickNextMove(workingFen, scene);
    if (!uci) { finishBatch(workingFen, visualizedMoves); return; }
    const preview = buildMovePreview(workingFen, uci);
    if (!preview) { finishBatch(workingFen, visualizedMoves); return; }
    setPhase({
      kind: 'announce',
      visibleFen,
      visualizedMoves,
      announcement: preview,
      cycleIndex: nextCycleIndex,
      depth: depthRef.current,
    });
  }

  function finishBatch(finalFen: string, visualizedMoves: MovePreview[]) {
    if (visualizedMoves.length === 0) {
      if (batchesOnSceneRef.current + 1 >= MAX_BATCHES_PER_POSITION) loadNewPosition();
      else { batchesOnSceneRef.current += 1; startBatch(finalFen); }
      return;
    }
    setPhase({ kind: 'review', finalFen, visualizedMoves, depth: depthRef.current });
  }

  // ── Static phase handlers ─────────────────────────────────────────────
  function handleStaticSubmit() {
    if (phase.kind !== 'static') return;
    const q = phase.questions[phase.qIndex];
    const verdict = gradeAnswer(Array.from(phase.selected) as never, q.correctSquares);
    setPhase({ ...phase, verdict });
    setScore((s) => accumulateScore(s, verdict));
  }

  function handleStaticNext() {
    if (phase.kind !== 'static' || phase.verdict == null) return;
    if (phase.qIndex + 1 < phase.questions.length) {
      setPhase({
        ...phase,
        qIndex: phase.qIndex + 1,
        selected: new Set(),
        verdict: null,
        peeking: false,
      });
      return;
    }
    if (phase.cycleIndex >= phase.depth) {
      finishBatch(getWorkingFen(phase.visibleFen, phase.visualizedMoves), phase.visualizedMoves);
      return;
    }
    const workingFen = getWorkingFen(phase.visibleFen, phase.visualizedMoves);
    announceNextMove(phase.visibleFen, workingFen, phase.visualizedMoves, phase.cycleIndex + 1);
  }

  function handleTogglePeek() {
    if (phase.kind !== 'static') return;
    setPhase({ ...phase, peeking: !phase.peeking });
  }

  // ── Announce phase handler ────────────────────────────────────────────
  function handleAnnounceNext() {
    if (phase.kind !== 'announce') return;
    const visualizedMoves = [...phase.visualizedMoves, phase.announcement];
    const imaginedFen = phase.announcement.fenAfter;

    absMoveRef.current += 1;
    const currentMove = absMoveRef.current;
    const depth = depthRef.current;
    const exclude = new Set<string>();
    for (const [sq, lastMove] of recentAskedRef.current) {
      if (lastMove > currentMove - depth && lastMove < currentMove) exclude.add(sq);
      if (lastMove <= currentMove - depth) recentAskedRef.current.delete(sq);
    }

    const questions = generateStaticQuestions(imaginedFen, questionsPerRoundRef.current, exclude as never);
    for (const q of questions) {
      for (const fs of q.focusSquares) recentAskedRef.current.set(fs, currentMove);
    }

    if (questions.length === 0) {
      if (phase.cycleIndex >= phase.depth) {
        finishBatch(imaginedFen, visualizedMoves);
      } else {
        announceNextMove(phase.visibleFen, imaginedFen, visualizedMoves, phase.cycleIndex + 1);
      }
      return;
    }

    setPhase({
      kind: 'static',
      visibleFen: phase.visibleFen,
      imaginedFen,
      visualizedMoves,
      cycleIndex: phase.cycleIndex,
      depth: phase.depth,
      questions,
      qIndex: 0,
      selected: new Set(),
      verdict: null,
      peeking: false,
    });
  }

  // ── Review phase handler ──────────────────────────────────────────────
  function handleReviewNext() {
    if (phase.kind !== 'review') return;
    batchesOnSceneRef.current += 1;
    if (batchesOnSceneRef.current >= MAX_BATCHES_PER_POSITION) loadNewPosition();
    else startBatch(phase.finalFen);
  }

  // ── Square tap (static phase only) ────────────────────────────────────
  function handleSquareSelect(sq: string) {
    if (phase.kind !== 'static') return;
    if (phase.verdict != null) return; // already submitted — wait for Next
    const next = new Set(phase.selected);
    if (next.has(sq)) next.delete(sq);
    else next.add(sq);
    setPhase({ ...phase, selected: next });
  }

  // Always go through the tools index so the back arrow lands on /tools even
  // if this screen was opened via a deep link, an HMR reload, or any other
  // entry that left the navigation stack without /tools below us.
  const navigateToTools = useCallback(() => {
    router.replace('/(tabs)/tools');
  }, [router]);

  // ── Render ────────────────────────────────────────────────────────────
  if (phase.kind === 'setup') {
    return (
      <AppShell>
        <SetupScreen
          phase={phase}
          colors={colorTheme}
          onBack={navigateToTools}
          onChangeDepth={(n) => setPhase({ ...phase, depthDraft: clampToRange(n, MIN_DEPTH, MAX_DEPTH) })}
          onChangeQuestions={(n) => setPhase({ ...phase, questionsDraft: clampToRange(n, MIN_QUESTIONS, MAX_QUESTIONS) })}
          onChangeOrientation={(o) => setPhase({ ...phase, orientationDraft: o })}
          onChangeShowCoords={(b) => setPhase({ ...phase, showCoordsDraft: b })}
          onChangeShowAnnounceIndicators={(b) => setPhase({ ...phase, showAnnounceIndicatorsDraft: b })}
          onChangeShowQuestionFocus={(b) => setPhase({ ...phase, showQuestionFocusDraft: b })}
          onStart={handleStartSession}
        />
      </AppShell>
    );
  }

  if (phase.kind === 'end') {
    return (
      <AppShell>
        <SessionEndScreen
          score={score}
          colors={colorTheme}
          onBackToTools={navigateToTools}
          onNew={() => setPhase({
            kind: 'setup',
            depthDraft: depthRef.current || DEFAULT_DEPTH,
            questionsDraft: questionsPerRoundRef.current || DEFAULT_QUESTIONS_PER_ROUND,
            orientationDraft: orientationRef.current || 'w',
            showCoordsDraft: showCoordsRef.current,
            showAnnounceIndicatorsDraft: showAnnounceIndicatorsRef.current,
            showQuestionFocusDraft: showQuestionFocusRef.current,
          })}
        />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <TrainerScreen
        phase={phase}
        score={score}
        colors={colorTheme}
        orientation={orientationRef.current}
        showCoords={showCoordsRef.current}
        showAnnounceIndicators={showAnnounceIndicatorsRef.current}
        showQuestionFocus={showQuestionFocusRef.current}
        openingName={openingName}
        positionCount={positionCount}
        onSquareSelect={handleSquareSelect}
        onStaticSubmit={handleStaticSubmit}
        onStaticNext={handleStaticNext}
        onTogglePeek={handleTogglePeek}
        onAnnounceNext={handleAnnounceNext}
        onReviewNext={handleReviewNext}
        onEndSession={() => setPhase({ kind: 'end' })}
      />
    </AppShell>
  );
}

function getWorkingFen(startFen: string, moves: MovePreview[]): string {
  if (moves.length === 0) return startFen;
  return moves[moves.length - 1].fenAfter;
}

// ── Setup screen ──────────────────────────────────────────────────────────
function SetupScreen({
  phase, colors, onBack,
  onChangeDepth, onChangeQuestions, onChangeOrientation, onChangeShowCoords,
  onChangeShowAnnounceIndicators, onChangeShowQuestionFocus, onStart,
}: {
  phase: SetupPhase;
  colors: ColorTheme;
  onBack: () => void;
  onChangeDepth: (n: number) => void;
  onChangeQuestions: (n: number) => void;
  onChangeOrientation: (o: BoardOrientation) => void;
  onChangeShowCoords: (b: boolean) => void;
  onChangeShowAnnounceIndicators: (b: boolean) => void;
  onChangeShowQuestionFocus: (b: boolean) => void;
  onStart: () => void;
}) {
  const {
    depthDraft, questionsDraft, orientationDraft, showCoordsDraft,
    showAnnounceIndicatorsDraft, showQuestionFocusDraft,
  } = phase;
  return (
    <ScrollView className="flex-1 bg-bg-base" contentContainerStyle={{ padding: 20 }}>
      <Pressable onPress={onBack} className="flex-row items-center gap-1 mb-4 active:opacity-70">
        <MaterialCommunityIcons name="chevron-left" size={20} color={colors.content.secondary} />
        <Text className="text-content-secondary text-sm">Tools</Text>
      </Pressable>

      <View className="bg-bg-surface border border-border rounded-2xl p-5">
        <View className="flex-row items-center gap-3 mb-3">
          <View className="w-10 h-10 rounded-xl bg-accent/10 items-center justify-center">
            <MaterialCommunityIcons name="eye-outline" size={20} color={colors.accent.default} />
          </View>
          <Text className="text-content-primary text-xl font-semibold">Vision Trainer</Text>
        </View>
        <Text className="text-content-secondary text-sm leading-6 mb-5">
          A move is announced in notation — no arrows, no highlights. Picture it on the
          board in your head, then identify which pieces can see a target square in the
          position you've been imagining. The board only catches up after several moves
          have stacked up.
        </Text>

        <Field label="Visualization Depth" hint="moves before the board applies">
          <NumberInput value={depthDraft} min={MIN_DEPTH} max={MAX_DEPTH} onChange={onChangeDepth} colors={colors} />
        </Field>

        <Field label="Questions per round" hint="asked after each announced move">
          <NumberInput value={questionsDraft} min={MIN_QUESTIONS} max={MAX_QUESTIONS} onChange={onChangeQuestions} colors={colors} />
        </Field>

        <Field label="Board orientation" hint="which side at the bottom">
          <View className="flex-row rounded-md border border-border overflow-hidden">
            {(['w', 'b'] as const).map((o) => {
              const selected = orientationDraft === o;
              return (
                <Pressable
                  key={o}
                  onPress={() => onChangeOrientation(o)}
                  className={`flex-1 py-2 ${selected ? 'bg-accent/15' : 'bg-bg-base'} active:opacity-70`}
                >
                  <Text className={`text-center text-sm ${selected ? 'text-accent font-medium' : 'text-content-secondary'}`}>
                    {o === 'w' ? 'White' : 'Black'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Field>

        <SettingToggle
          label="Show board coordinates"
          hint="a–h letters and 1–8 rank labels"
          value={showCoordsDraft}
          onChange={onChangeShowCoords}
        />
        <SettingToggle
          label="Show move announcement indicators"
          hint="arrow and from→to highlights when a move is announced"
          value={showAnnounceIndicatorsDraft}
          onChange={onChangeShowAnnounceIndicators}
        />
        <SettingToggle
          label="Show question target square"
          hint="highlight the square being asked about"
          value={showQuestionFocusDraft}
          onChange={onChangeShowQuestionFocus}
        />

        <Text className="text-content-muted text-xs mb-5 leading-5">
          Each batch:{' '}
          <Text className="text-content-secondary font-medium">{depthDraft}</Text> announced move{depthDraft === 1 ? '' : 's'},
          each followed by <Text className="text-content-secondary font-medium">{questionsDraft}</Text> question{questionsDraft === 1 ? '' : 's'} about the imagined position
          ({depthDraft * questionsDraft} questions total before the board catches up).
          {depthDraft >= 5 ? ' Heavy blindfold practice.' : ''}
        </Text>

        <View className="flex-row items-center justify-between gap-3">
          <Pressable
            onPress={onBack}
            className="px-4 py-2 rounded-lg bg-bg-elevated border border-border active:opacity-70"
          >
            <View className="flex-row items-center gap-1.5">
              <MaterialCommunityIcons name="arrow-left" size={14} color={colors.content.secondary} />
              <Text className="text-content-secondary text-sm">Tools</Text>
            </View>
          </Pressable>
          <Pressable
            onPress={onStart}
            className="px-5 py-2 rounded-lg bg-accent active:opacity-80"
          >
            <View className="flex-row items-center gap-1.5">
              <Text className="text-bg-base font-semibold">Start session</Text>
              <MaterialCommunityIcons name="play" size={14} color={colors.bg.base} />
            </View>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

function SettingToggle({
  label, hint, value, onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      className="mb-4 flex-row items-center justify-between gap-3 active:opacity-70"
    >
      <View className="flex-1">
        <Text className="text-content-primary text-sm font-medium">{label}</Text>
        <Text className="text-content-muted text-xs mt-0.5">{hint}</Text>
      </View>
      <View
        className={`relative w-11 h-6 rounded-full border ${
          value ? 'bg-accent/30 border-accent/60' : 'bg-bg-base border-border'
        }`}
      >
        <View
          className={`absolute top-0.5 w-4 h-4 rounded-full ${
            value ? 'bg-accent' : 'bg-content-muted'
          }`}
          style={{ left: value ? 22 : 2 }}
        />
      </View>
    </Pressable>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <View className="mb-5">
      <View className="flex-row items-end justify-between mb-2">
        <Text className="text-content-primary text-sm font-medium">{label}</Text>
        <Text className="text-content-muted text-xs">{hint}</Text>
      </View>
      {children}
    </View>
  );
}

// Custom number input: text field + −/+ buttons. Matches the web NumberInput
// behavior — typing pushes a clamped value up on every valid keystroke.
function NumberInput({
  value, min, max, onChange, colors,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  colors: ColorTheme;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft((cur) => {
      const parsed = parseInt(cur, 10);
      if (Number.isFinite(parsed) && parsed === value) return cur;
      return String(value);
    });
  }, [value]);

  function bump(delta: number) {
    onChange(clampToRange(value + delta, min, max));
  }

  function handleText(raw: string) {
    // Allow only digits while editing.
    const cleaned = raw.replace(/[^0-9]/g, '');
    setDraft(cleaned);
    const parsed = parseInt(cleaned, 10);
    if (Number.isFinite(parsed)) {
      const clamped = clampToRange(parsed, min, max);
      if (clamped !== value) onChange(clamped);
    }
  }

  function handleBlur() {
    const parsed = parseInt(draft, 10);
    if (!Number.isFinite(parsed)) setDraft(String(value));
    else setDraft(String(clampToRange(parsed, min, max)));
  }

  return (
    <View className="flex-row items-stretch self-end bg-bg-base border border-border rounded-md overflow-hidden h-10">
      <Pressable
        onPress={() => bump(-1)}
        disabled={value <= min}
        className="px-3 justify-center border-r border-border active:bg-bg-elevated"
        style={{ opacity: value <= min ? 0.3 : 1 }}
      >
        <MaterialCommunityIcons name="minus" size={16} color={colors.content.secondary} />
      </Pressable>
      <TextInput
        value={draft}
        onChangeText={handleText}
        onBlur={handleBlur}
        keyboardType="number-pad"
        selectTextOnFocus
        className="w-14 text-content-primary text-center"
        placeholderTextColor={colors.content.muted}
      />
      <Pressable
        onPress={() => bump(1)}
        disabled={value >= max}
        className="px-3 justify-center border-l border-border active:bg-bg-elevated"
        style={{ opacity: value >= max ? 0.3 : 1 }}
      >
        <MaterialCommunityIcons name="plus" size={16} color={colors.content.secondary} />
      </Pressable>
    </View>
  );
}

// ── Trainer screen ────────────────────────────────────────────────────────
type TrainerScreenProps = {
  phase: Exclude<Phase, SetupPhase | { kind: 'end' }>;
  score: Score;
  colors: ColorTheme;
  orientation: BoardOrientation;
  showCoords: boolean;
  showAnnounceIndicators: boolean;
  showQuestionFocus: boolean;
  openingName: string;
  positionCount: number;
  onSquareSelect: (sq: string) => void;
  onStaticSubmit: () => void;
  onStaticNext: () => void;
  onTogglePeek: () => void;
  onAnnounceNext: () => void;
  onReviewNext: () => void;
  onEndSession: () => void;
};

function TrainerScreen(p: TrainerScreenProps) {
  const screen = Dimensions.get('window');
  const boardSize = Math.min(screen.width - 24, screen.height - 360, 480);

  if (p.phase.kind === 'loading') {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-content-secondary text-sm">{p.phase.message}</Text>
      </View>
    );
  }

  const view = buildBoardView(p, boardSize);

  return (
    <ScrollView
      className="flex-1 bg-bg-base"
      contentContainerStyle={{ padding: 12, gap: 10 }}
    >
      {/* Top row: depth chip + End button */}
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-row items-center gap-1.5 bg-bg-surface border border-border rounded-md px-2.5 py-1.5">
          <MaterialCommunityIcons name="eye-outline" size={12} color={p.colors.accent.default} />
          <Text className="text-content-secondary text-xs">
            Depth: <Text className="text-content-primary font-semibold">{depthOf(p.phase)}</Text>
          </Text>
        </View>
        <Pressable
          onPress={p.onEndSession}
          className="flex-row items-center gap-1 px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border active:opacity-70"
        >
          <MaterialCommunityIcons name="stop-circle-outline" size={12} color={p.colors.content.secondary} />
          <Text className="text-content-secondary text-xs">End</Text>
        </Pressable>
      </View>

      {/* Score strip */}
      <ScoreStrip score={p.score} openingName={p.openingName} positionCount={p.positionCount} colors={p.colors} />

      {/* Prompt */}
      {view.prompt && (
        <View className="bg-bg-surface border border-border rounded-lg px-3 py-2">
          <Text className="text-content-primary text-sm leading-snug">{view.prompt}</Text>
          {view.helper && (
            <Text className="text-content-muted text-xs mt-0.5 leading-snug">{view.helper}</Text>
          )}
        </View>
      )}

      {/* Board */}
      <View className="items-center">
        <View style={{ width: boardSize }}>
          <Chessboard
            fen={view.boardFen}
            orientation={p.orientation === 'b' ? 'black' : 'white'}
            onSquareSelect={p.onSquareSelect}
            squareStyles={view.squareStyles}
            arrows={view.arrows.length ? view.arrows : undefined}
            size={boardSize}
            showNotation={p.showCoords}
          />
        </View>
      </View>

      {/* Footer (actions) */}
      <View>{view.footer}</View>

      {/* Visualized moves panel (only when peeking or in review) */}
      {view.showList && <VisualizedList moves={view.listMoves} />}
    </ScrollView>
  );
}

function depthOf(phase: Exclude<Phase, SetupPhase | { kind: 'end' }>): number {
  if (phase.kind === 'static' || phase.kind === 'announce' || phase.kind === 'review') return phase.depth;
  return 0;
}

type BoardView = {
  boardFen: string;
  squareStyles: Record<string, StyleProp<ViewStyle>>;
  arrows: Array<{ from: string; to: string; color?: string }>;
  prompt: string | null;
  helper: string | null;
  footer: React.ReactNode;
  showList: boolean;
  listMoves: MovePreview[];
};

function buildBoardView(p: TrainerScreenProps, _boardSize: number): BoardView {
  const colors = p.colors;
  const focusBg = withAlpha(colors.gold.default, 0.40);
  const focusBorder = withAlpha(colors.gold.default, 0.95);
  const selectedBg = withAlpha(colors.accent.default, 0.50);
  const selectedBorder = colors.accent.default;
  const correctBg = withAlpha(colors.success, 0.55);
  const missedBg = 'rgba(245, 158, 11, 0.55)';
  const wrongBg = withAlpha(colors.danger, 0.55);

  switch (p.phase.kind) {
    case 'static': {
      const q = p.phase.questions[p.phase.qIndex];
      const verdict = p.phase.verdict;
      const peeking = p.phase.peeking;
      const styles: Record<string, ViewStyle> = {};

      // Focus highlight on target square is gated by the user pref. Once
      // feedback is in, always show it so the green/orange/red overlay
      // reads in context.
      const showFocus = p.showQuestionFocus || verdict != null;
      if (showFocus) {
        for (const f of q.focusSquares) {
          styles[f] = { backgroundColor: focusBg, borderWidth: 3, borderColor: focusBorder };
        }
      }
      if (verdict == null) {
        for (const s of p.phase.selected) {
          styles[s] = {
            ...(styles[s] ?? {}),
            backgroundColor: selectedBg,
            borderWidth: 3,
            borderColor: selectedBorder,
          };
        }
      } else {
        for (const s of verdict.correct) styles[s] = { backgroundColor: correctBg };
        for (const s of verdict.missed) styles[s] = { backgroundColor: missedBg };
        for (const s of verdict.wrong)  styles[s] = { backgroundColor: wrongBg };
        for (const f of q.focusSquares) {
          styles[f] = { ...(styles[f] ?? {}), borderWidth: 3, borderColor: focusBorder };
        }
      }
      const helperBits: string[] = [`Question ${p.phase.qIndex + 1} / ${p.phase.questions.length}`];
      if (p.phase.depth > 1) helperBits.push(`Cycle ${p.phase.cycleIndex} / ${p.phase.depth}`);
      return {
        boardFen: peeking ? p.phase.imaginedFen : p.phase.visibleFen,
        squareStyles: styles,
        arrows: [],
        prompt: q.prompt,
        helper: helperBits.join(' · '),
        footer: (
          <StaticFooter
            verdict={verdict}
            selCount={p.phase.selected.size}
            qIndex={p.phase.qIndex}
            total={p.phase.questions.length}
            cycleIndex={p.phase.cycleIndex}
            depth={p.phase.depth}
            peeking={peeking}
            colors={colors}
            onSubmit={p.onStaticSubmit}
            onNext={p.onStaticNext}
            onTogglePeek={p.onTogglePeek}
          />
        ),
        showList: peeking,
        listMoves: p.phase.visualizedMoves,
      };
    }

    case 'announce': {
      const m = p.phase.announcement;
      const fullCycleLabel = p.phase.depth > 1 ? ` (cycle ${p.phase.cycleIndex} / ${p.phase.depth})` : '';
      const isBlack = m.pieceColor === 'b';
      const sanWithEllipsis = isBlack ? `…${m.san}` : m.san;
      const sideLabel = isBlack ? 'Black' : 'White';
      const styles: Record<string, ViewStyle> = {};
      const arrows: Array<{ from: string; to: string; color?: string }> = [];
      if (p.showAnnounceIndicators) {
        styles[m.from] = { backgroundColor: focusBg, borderWidth: 3, borderColor: focusBorder };
        styles[m.to]   = { borderWidth: 3, borderColor: selectedBorder };
        arrows.push({ from: m.from, to: m.to, color: colors.accent.default });
      }
      return {
        boardFen: p.phase.visibleFen,
        squareStyles: styles,
        arrows,
        prompt: `Move played: ${sanWithEllipsis} (${sideLabel})${fullCycleLabel}`,
        helper: 'Read the move, picture it in your head, then tap Next.',
        footer: (
          <View className="flex-row justify-end">
            <Pressable
              onPress={p.onAnnounceNext}
              className="px-5 py-2 rounded-lg bg-accent active:opacity-80"
            >
              <View className="flex-row items-center gap-1.5">
                <Text className="text-bg-base font-semibold">Next</Text>
                <MaterialCommunityIcons name="chevron-right" size={14} color={colors.bg.base} />
              </View>
            </Pressable>
          </View>
        ),
        showList: false,
        listMoves: [],
      };
    }

    case 'review': {
      return {
        boardFen: p.phase.finalFen,
        squareStyles: {},
        arrows: [],
        prompt: `${p.phase.visualizedMoves.length} move${p.phase.visualizedMoves.length === 1 ? '' : 's'} applied — the position you were imagining is now on the board.`,
        helper: 'Continue training on the updated position.',
        footer: (
          <View className="flex-row justify-end">
            <Pressable
              onPress={p.onReviewNext}
              className="px-5 py-2 rounded-lg bg-accent active:opacity-80"
            >
              <View className="flex-row items-center gap-1.5">
                <Text className="text-bg-base font-semibold">Continue</Text>
                <MaterialCommunityIcons name="chevron-right" size={14} color={colors.bg.base} />
              </View>
            </Pressable>
          </View>
        ),
        showList: true,
        listMoves: p.phase.visualizedMoves,
      };
    }

    case 'loading':
      return {
        boardFen: 'start',
        squareStyles: {},
        arrows: [],
        prompt: null,
        helper: null,
        footer: null,
        showList: false,
        listMoves: [],
      };
  }
}

// ── UI bits ───────────────────────────────────────────────────────────────
function StaticFooter({
  verdict, selCount, qIndex, total, cycleIndex, depth, peeking, colors,
  onSubmit, onNext, onTogglePeek,
}: {
  verdict: AnswerVerdict | null;
  selCount: number;
  qIndex: number;
  total: number;
  cycleIndex: number;
  depth: number;
  peeking: boolean;
  colors: ColorTheme;
  onSubmit: () => void;
  onNext: () => void;
  onTogglePeek: () => void;
}) {
  if (verdict == null) {
    return (
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-content-muted text-xs">{selCount} selected</Text>
        <Pressable
          onPress={onSubmit}
          className="px-4 py-2 rounded-lg bg-accent active:opacity-80"
        >
          <View className="flex-row items-center gap-1.5">
            <Text className="text-bg-base font-semibold">Submit</Text>
            <MaterialCommunityIcons name="check" size={14} color={colors.bg.base} />
          </View>
        </Pressable>
      </View>
    );
  }
  const isLastInCycle = qIndex + 1 >= total;
  const isLastCycle = cycleIndex >= depth;
  const nextLabel = isLastInCycle
    ? isLastCycle ? 'Apply moves' : 'Next move'
    : 'Next question';
  const showPeek = !verdict.isPerfect;
  return (
    <View className="flex-row items-center justify-between gap-3">
      <VerdictPill verdict={verdict} colors={colors} />
      <View className="flex-row items-center gap-2">
        {showPeek && (
          <Pressable
            onPress={onTogglePeek}
            className={`px-2.5 py-2 rounded-md border ${peeking ? 'bg-accent/15 border-accent/50' : 'bg-bg-surface border-border'} active:opacity-70`}
          >
            <View className="flex-row items-center gap-1">
              <MaterialCommunityIcons name="eye-outline" size={12} color={peeking ? colors.accent.default : colors.content.secondary} />
              <Text className={`text-xs ${peeking ? 'text-accent' : 'text-content-secondary'}`}>
                {peeking ? 'Hide' : 'Peek'}
              </Text>
            </View>
          </Pressable>
        )}
        <Pressable
          onPress={onNext}
          className="px-4 py-2 rounded-lg bg-accent active:opacity-80"
        >
          <View className="flex-row items-center gap-1.5">
            <Text className="text-bg-base font-semibold">{nextLabel}</Text>
            <MaterialCommunityIcons name="chevron-right" size={14} color={colors.bg.base} />
          </View>
        </Pressable>
      </View>
    </View>
  );
}

function VerdictPill({ verdict, colors: _colors }: { verdict: AnswerVerdict; colors: ColorTheme }) {
  if (verdict.isPerfect) {
    return (
      <View className="bg-success/10 border border-success/30 rounded-md px-2 py-1 flex-row items-center gap-1">
        <Text className="text-success text-xs">✓ Perfect — all {verdict.correct.length} squares</Text>
      </View>
    );
  }
  return (
    <View className="bg-bg-elevated border border-border rounded-md px-2 py-1 flex-row items-center gap-2">
      <Text className="text-success text-xs">{verdict.correct.length} ✓</Text>
      <Text className="text-xs" style={{ color: 'rgb(245, 158, 11)' }}>{verdict.missed.length} missed</Text>
      <Text className="text-danger text-xs">{verdict.wrong.length} ✗</Text>
    </View>
  );
}

function ScoreStrip({
  score, openingName, positionCount, colors: _colors,
}: {
  score: Score;
  openingName: string;
  positionCount: number;
  colors: ColorTheme;
}) {
  const total = score.correctSquares + score.wrongSquares + score.missedSquares;
  const pct = total === 0 ? null : Math.round((score.correctSquares / total) * 100);
  return (
    <View className="flex-row items-center justify-between gap-2 px-1">
      <View className="flex-row items-center flex-1 min-w-0">
        {openingName ? (
          <Text className="text-content-secondary text-xs flex-1" numberOfLines={1}>
            {openingName}{positionCount > 0 ? ` · #${positionCount}` : ''}
          </Text>
        ) : <View className="flex-1" />}
      </View>
      <View className="flex-row items-center gap-2">
        {score.questionsAnswered > 0 && (
          <>
            <Text className="text-content-muted text-xs">{score.perfectAnswers} ✓</Text>
            {pct != null && <Text className="text-content-secondary text-xs">{pct}%</Text>}
          </>
        )}
      </View>
    </View>
  );
}

function VisualizedList({ moves }: { moves: MovePreview[] }) {
  const text = moves.length > 0 ? moves.map((m, i) => `${i + 1}. ${m.san}`).join('  ') : null;
  return (
    <View className="bg-bg-elevated border border-border rounded-lg px-3 py-2">
      <Text className="text-content-muted text-xs mb-1 tracking-wider uppercase">Visualized moves</Text>
      {text ? (
        <Text className="text-content-primary text-sm font-mono">{text}</Text>
      ) : (
        <Text className="text-content-muted text-xs">No moves visualized yet.</Text>
      )}
    </View>
  );
}

// ── Session end screen ────────────────────────────────────────────────────
function SessionEndScreen({
  score, colors, onBackToTools, onNew,
}: {
  score: Score;
  colors: ColorTheme;
  onBackToTools: () => void;
  onNew: () => void;
}) {
  const total = score.correctSquares + score.wrongSquares + score.missedSquares;
  const pct = total === 0 ? 0 : Math.round((score.correctSquares / total) * 100);
  return (
    <ScrollView className="flex-1 bg-bg-base" contentContainerStyle={{ padding: 20 }}>
      <View className="bg-bg-surface border border-border rounded-2xl p-6 items-center">
        <View className="w-14 h-14 rounded-2xl bg-accent/10 items-center justify-center mb-3">
          <MaterialCommunityIcons name="eye-outline" size={28} color={colors.accent.default} />
        </View>
        <Text className="text-content-primary text-xl font-semibold mb-1">Session ended</Text>
        <Text className="text-content-secondary text-sm text-center mb-5">Nice work tracking that piece vision.</Text>

        <View className="flex-row flex-wrap justify-center gap-2 mb-5">
          <Stat label="Questions" value={score.questionsAnswered} />
          <Stat label="Perfect" value={score.perfectAnswers} />
          <Stat label="Correct" value={score.correctSquares} />
          <Stat label="Accuracy" value={`${pct}%`} />
        </View>

        <View className="flex-row items-center justify-center gap-3">
          <Pressable
            onPress={onBackToTools}
            className="px-4 py-2 rounded-lg bg-bg-elevated border border-border active:opacity-70"
          >
            <View className="flex-row items-center gap-1.5">
              <MaterialCommunityIcons name="arrow-left" size={14} color={colors.content.secondary} />
              <Text className="text-content-secondary text-sm">Tools</Text>
            </View>
          </Pressable>
          <Pressable
            onPress={onNew}
            className="px-4 py-2 rounded-lg bg-accent active:opacity-80"
          >
            <View className="flex-row items-center gap-1.5">
              <MaterialCommunityIcons name="refresh" size={14} color={colors.bg.base} />
              <Text className="text-bg-base font-semibold">New session</Text>
            </View>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <View className="bg-bg-base border border-border rounded-lg px-4 py-3 min-w-[120px]">
      <Text className="text-content-primary text-lg font-semibold">{value}</Text>
      <Text className="text-content-muted text-xs">{label}</Text>
    </View>
  );
}
