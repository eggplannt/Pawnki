import { Component, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Chessboard } from 'react-chessboard';
import { type Square } from 'chess.js';
import Icon from '@mdi/react';
import {
  mdiArrowLeft,
  mdiChevronRight,
  mdiCheck,
  mdiEye,
  mdiMinus,
  mdiPlay,
  mdiPlus,
  mdiRefresh,
  mdiStopCircleOutline,
} from '@mdi/js';
import { AppShell } from '@/components/AppShell';
import { useColorTheme } from '@/hooks/useColorTheme';
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

// ── Board error boundary ──────────────────────────────────────────────────
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

// ── Phase machine ─────────────────────────────────────────────────────────
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
  /** Board's frozen position (never changes during a batch). */
  visibleFen: string;
  /** Position the questions are about — equals visibleFen at cycle 0. */
  imaginedFen: string;
  /** Moves the player has been told about so far in this batch. */
  visualizedMoves: MovePreview[];
  /** 1..depth = after that many move announcements. */
  cycleIndex: number;
  /** Configured depth (announcements per batch). */
  depth: number;
  questions: VisionQuestion[];
  qIndex: number;
  selected: Set<Square>;
  verdict: AnswerVerdict | null;
  /** Toggled by the Peek button — temporarily shows imaginedFen instead of visibleFen. */
  peeking: boolean;
};

type AnnouncePhase = {
  kind: 'announce';
  visibleFen: string;
  /** Already-visualized moves (does NOT include the move being announced now). */
  visualizedMoves: MovePreview[];
  /** The move being shown right now. */
  announcement: MovePreview;
  /** Cycle the announce belongs to (i.e., the cycle the NEXT static phase will run as). */
  cycleIndex: number;
  depth: number;
};

type ReviewPhase = {
  kind: 'review';
  /** Position after all visualized moves are applied. */
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

const MAX_BATCHES_PER_POSITION = 3; // after this many batches on one scene, fetch a new scene
const DEFAULT_DEPTH = 3;
const DEFAULT_QUESTIONS_PER_ROUND = 3;
const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 10;

// ── Slider preference persistence ─────────────────────────────────────────
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

function loadDepthPref(): number {
  try {
    const raw = localStorage.getItem(DEPTH_STORAGE_KEY);
    if (!raw) return DEFAULT_DEPTH;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 50) return n;
  } catch { /* ignored */ }
  return DEFAULT_DEPTH;
}
function saveDepthPref(n: number): void {
  try { localStorage.setItem(DEPTH_STORAGE_KEY, String(n)); } catch { /* ignored */ }
}
function loadQuestionsPref(): number {
  try {
    const raw = localStorage.getItem(QUESTIONS_STORAGE_KEY);
    if (!raw) return DEFAULT_QUESTIONS_PER_ROUND;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= MIN_QUESTIONS && n <= MAX_QUESTIONS) return n;
  } catch { /* ignored */ }
  return DEFAULT_QUESTIONS_PER_ROUND;
}
function saveQuestionsPref(n: number): void {
  try { localStorage.setItem(QUESTIONS_STORAGE_KEY, String(n)); } catch { /* ignored */ }
}
function loadOrientationPref(): BoardOrientation {
  try {
    const raw = localStorage.getItem(ORIENTATION_STORAGE_KEY);
    if (raw === 'w' || raw === 'b') return raw;
  } catch { /* ignored */ }
  return 'w';
}
function saveOrientationPref(o: BoardOrientation): void {
  try { localStorage.setItem(ORIENTATION_STORAGE_KEY, o); } catch { /* ignored */ }
}
function loadCoordsPref(): boolean {
  try {
    const raw = localStorage.getItem(COORDS_STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignored */ }
  return false;
}
function saveCoordsPref(b: boolean): void {
  try { localStorage.setItem(COORDS_STORAGE_KEY, b ? '1' : '0'); } catch { /* ignored */ }
}
function loadBoolPref(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignored */ }
  return fallback;
}
function saveBoolPref(key: string, b: boolean): void {
  try { localStorage.setItem(key, b ? '1' : '0'); } catch { /* ignored */ }
}

// ── Component ─────────────────────────────────────────────────────────────
export default function VisionTrainer() {
  const [phase, setPhase] = useState<Phase>(() => ({
    kind: 'setup',
    depthDraft: loadDepthPref(),
    questionsDraft: loadQuestionsPref(),
    orientationDraft: loadOrientationPref(),
    showCoordsDraft: loadCoordsPref(),
    showAnnounceIndicatorsDraft: loadBoolPref(ANNOUNCE_IND_STORAGE_KEY, false),
    showQuestionFocusDraft: loadBoolPref(QUESTION_FOCUS_STORAGE_KEY, false),
  }));
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

  // Rolling-window exclusion: don't ask about a square that's already been
  // a focus in the last `depth` announced moves. Map of focus square → the
  // absolute move number it was last asked at.
  const recentAskedRef = useRef<Map<Square, number>>(new Map());
  // Absolute move counter, incremented at every announcement.
  const absMoveRef = useRef(0);

  // ── Session entry points ───────────────────────────────────────────────
  function handleStartSession() {
    if (phase.kind !== 'setup') return;
    const depth = phase.depthDraft;
    const qpr = phase.questionsDraft;
    const orientation = phase.orientationDraft;
    const showCoords = phase.showCoordsDraft;
    const announceInd = phase.showAnnounceIndicatorsDraft;
    const questionFocus = phase.showQuestionFocusDraft;
    saveDepthPref(depth);
    saveQuestionsPref(qpr);
    saveOrientationPref(orientation);
    saveCoordsPref(showCoords);
    saveBoolPref(ANNOUNCE_IND_STORAGE_KEY, announceInd);
    saveBoolPref(QUESTION_FOCUS_STORAGE_KEY, questionFocus);
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
    queueMicrotask(() => loadNewPosition());
  }

  const loadNewPosition = useCallback(() => {
    const scene = buildScene();
    sceneRef.current = scene;
    batchesOnSceneRef.current = 0;
    setOpeningName(scene.source);
    setPositionCount((p) => p + 1);
    startBatch(scene.fen);
  }, []);

  function startBatch(fen: string) {
    // The visible position is never the subject of questions — we go straight
    // to the first announcement. Each cycle's questions are about the position
    // imagined after the announced moves.
    announceNextMove(fen, fen, [], 1);
  }

  function announceNextMove(
    visibleFen: string,
    workingFen: string,
    visualizedMoves: MovePreview[],
    nextCycleIndex: number,
  ) {
    const scene = sceneRef.current;
    if (!scene) {
      loadNewPosition();
      return;
    }
    const uci = pickNextMove(workingFen, scene);
    if (!uci) {
      // Source exhausted — apply what we have and move on.
      finishBatch(workingFen, visualizedMoves);
      return;
    }
    const preview = buildMovePreview(workingFen, uci);
    if (!preview) {
      finishBatch(workingFen, visualizedMoves);
      return;
    }
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
      // No moves were ever announced — nothing to review. Just continue with a new batch.
      if (batchesOnSceneRef.current + 1 >= MAX_BATCHES_PER_POSITION) {
        loadNewPosition();
      } else {
        batchesOnSceneRef.current += 1;
        startBatch(finalFen);
      }
      return;
    }
    setPhase({
      kind: 'review',
      finalFen,
      visualizedMoves,
      depth: depthRef.current,
    });
  }

  // ── Static phase handlers ──────────────────────────────────────────────
  function handleStaticSubmit() {
    if (phase.kind !== 'static') return;
    const q = phase.questions[phase.qIndex];
    const verdict = gradeAnswer(Array.from(phase.selected), q.correctSquares);
    setPhase({ ...phase, verdict });
    setScore((s) => accumulateScore(s, verdict));
  }

  function handleStaticNext() {
    if (phase.kind !== 'static' || phase.verdict == null) return;
    // Advancing to the next question wipes the peek toggle (matches the spec:
    // peek "goes away in the next question/move").
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
    // Out of questions in this cycle. Decide what comes next.
    if (phase.cycleIndex >= phase.depth) {
      // Batch complete — apply moves.
      finishBatch(getWorkingFenFromMoves(phase.visibleFen, phase.visualizedMoves), phase.visualizedMoves);
      return;
    }
    // Announce the next move.
    const workingFen = getWorkingFenFromMoves(phase.visibleFen, phase.visualizedMoves);
    announceNextMove(phase.visibleFen, workingFen, phase.visualizedMoves, phase.cycleIndex + 1);
  }

  function handleTogglePeek() {
    if (phase.kind !== 'static') return;
    setPhase({ ...phase, peeking: !phase.peeking });
  }

  // ── Announce phase handler ─────────────────────────────────────────────
  function handleAnnounceNext() {
    if (phase.kind !== 'announce') return;
    const visualizedMoves = [...phase.visualizedMoves, phase.announcement];
    const imaginedFen = phase.announcement.fenAfter;

    // Roll the absolute-move counter and compute the no-repeat exclusion window.
    absMoveRef.current += 1;
    const currentMove = absMoveRef.current;
    const depth = depthRef.current;
    const exclude = new Set<Square>();
    for (const [sq, lastMove] of recentAskedRef.current) {
      // Squares asked in the prior `depth - 1` moves are off-limits this cycle.
      if (lastMove > currentMove - depth && lastMove < currentMove) exclude.add(sq);
      // Drop entries that have aged out of the window so the map doesn't grow.
      if (lastMove <= currentMove - depth) recentAskedRef.current.delete(sq);
    }

    const questions = generateStaticQuestions(imaginedFen, questionsPerRoundRef.current, exclude);

    // Record the focus squares of the new questions against the current move.
    for (const q of questions) {
      for (const fs of q.focusSquares) recentAskedRef.current.set(fs, currentMove);
    }

    if (questions.length === 0) {
      // No interesting questions for this imagined position. Skip ahead.
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

  // ── Review phase handler ───────────────────────────────────────────────
  function handleReviewNext() {
    if (phase.kind !== 'review') return;
    batchesOnSceneRef.current += 1;
    if (batchesOnSceneRef.current >= MAX_BATCHES_PER_POSITION) loadNewPosition();
    else startBatch(phase.finalFen);
  }

  // ── Board click handling (shared) ──────────────────────────────────────
  function handleSquareClick({ square }: { square: string | null }) {
    if (!square) return;
    if (phase.kind === 'static') {
      if (phase.verdict != null) return;
      const next = new Set(phase.selected);
      if (next.has(square as Square)) next.delete(square as Square);
      else next.add(square as Square);
      setPhase({ ...phase, selected: next });
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  if (phase.kind === 'setup') {
    return (
      <AppShell>
        <SetupScreen
          depthDraft={phase.depthDraft}
          questionsDraft={phase.questionsDraft}
          orientationDraft={phase.orientationDraft}
          showCoordsDraft={phase.showCoordsDraft}
          showAnnounceIndicatorsDraft={phase.showAnnounceIndicatorsDraft}
          showQuestionFocusDraft={phase.showQuestionFocusDraft}
          onChangeDepth={(n) => setPhase({ ...phase, depthDraft: n })}
          onChangeQuestions={(n) => setPhase({ ...phase, questionsDraft: n })}
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
          onRestart={() => setPhase({
            kind: 'setup',
            depthDraft: depthRef.current || loadDepthPref(),
            questionsDraft: questionsPerRoundRef.current || loadQuestionsPref(),
            orientationDraft: orientationRef.current || loadOrientationPref(),
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
      <TrainerLayout
        phase={phase}
        score={score}
        depth={depthRef.current}
        orientation={orientationRef.current}
        showCoords={showCoordsRef.current}
        showAnnounceIndicators={showAnnounceIndicatorsRef.current}
        showQuestionFocus={showQuestionFocusRef.current}
        openingName={openingName}
        positionCount={positionCount}
        onSquareClick={handleSquareClick}
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

// ── Helper: replay moves to get the FEN we'd land on ──────────────────────
function getWorkingFenFromMoves(startFen: string, moves: MovePreview[]): string {
  if (moves.length === 0) return startFen;
  return moves[moves.length - 1].fenAfter;
}

// ── Setup screen ──────────────────────────────────────────────────────────
function SetupScreen({
  depthDraft, questionsDraft, orientationDraft, showCoordsDraft,
  showAnnounceIndicatorsDraft, showQuestionFocusDraft,
  onChangeDepth, onChangeQuestions, onChangeOrientation, onChangeShowCoords,
  onChangeShowAnnounceIndicators, onChangeShowQuestionFocus, onStart,
}: {
  depthDraft: number;
  questionsDraft: number;
  orientationDraft: BoardOrientation;
  showCoordsDraft: boolean;
  showAnnounceIndicatorsDraft: boolean;
  showQuestionFocusDraft: boolean;
  onChangeDepth: (n: number) => void;
  onChangeQuestions: (n: number) => void;
  onChangeOrientation: (o: BoardOrientation) => void;
  onChangeShowCoords: (b: boolean) => void;
  onChangeShowAnnounceIndicators: (b: boolean) => void;
  onChangeShowQuestionFocus: (b: boolean) => void;
  onStart: () => void;
}) {
  return (
    <div className="flex-1 flex items-center justify-center p-4 sm:p-6 overflow-auto">
      <div className="max-w-md w-full bg-bg-surface border border-border rounded-2xl p-5 sm:p-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-accent/10 text-accent flex items-center justify-center">
            <Icon path={mdiEye} size={0.9} />
          </div>
          <h2 className="text-content-primary text-xl font-semibold">Vision Trainer</h2>
        </div>
        <p className="text-content-secondary text-sm leading-6 mb-6">
          A move is announced in notation — no arrows, no highlights. You picture it on the
          board in your head, then identify which pieces can see a target square in the
          position you've been imagining. The board only catches up after several moves
          have stacked up.
        </p>

        <div className="mb-5">
          <div className="flex items-baseline justify-between mb-2">
            <label className="text-content-primary text-sm font-medium" htmlFor="vision-depth">
              Visualization Depth
            </label>
            <span className="text-content-muted text-xs">moves before the board applies</span>
          </div>
          <div className="flex items-center gap-3">
            <input
              id="vision-depth"
              type="range"
              min={1}
              max={50}
              step={1}
              value={depthDraft}
              onChange={(e) => onChangeDepth(parseInt(e.target.value, 10))}
              className="flex-1 accent-accent"
            />
            <NumberInput value={depthDraft} min={1} max={50} onChange={onChangeDepth} ariaLabel="Visualization depth" />
          </div>
        </div>

        <div className="mb-6">
          <div className="flex items-baseline justify-between mb-2">
            <label className="text-content-primary text-sm font-medium" htmlFor="vision-questions">
              Questions per round
            </label>
            <span className="text-content-muted text-xs">asked after each announced move</span>
          </div>
          <div className="flex items-center gap-3">
            <input
              id="vision-questions"
              type="range"
              min={MIN_QUESTIONS}
              max={MAX_QUESTIONS}
              step={1}
              value={questionsDraft}
              onChange={(e) => onChangeQuestions(parseInt(e.target.value, 10))}
              className="flex-1 accent-accent"
            />
            <NumberInput value={questionsDraft} min={MIN_QUESTIONS} max={MAX_QUESTIONS} onChange={onChangeQuestions} ariaLabel="Questions per round" />
          </div>
        </div>

        <div className="mb-5">
          <div className="flex items-baseline justify-between mb-2">
            <label className="text-content-primary text-sm font-medium">
              Board orientation
            </label>
            <span className="text-content-muted text-xs">which side at the bottom</span>
          </div>
          <div className="flex rounded-md border border-border overflow-hidden">
            {(['w', 'b'] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => onChangeOrientation(o)}
                className={`flex-1 px-3 py-2 text-sm transition-colors ${
                  orientationDraft === o
                    ? 'bg-accent/15 text-accent font-medium'
                    : 'bg-bg-base text-content-secondary hover:text-content-primary hover:bg-bg-elevated'
                }`}
              >
                {o === 'w' ? 'White' : 'Black'}
              </button>
            ))}
          </div>
        </div>

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
          hint="highlight the square being asked about (the X in 'pieces that see X')"
          value={showQuestionFocusDraft}
          onChange={onChangeShowQuestionFocus}
        />

        <p className="text-content-muted text-xs mb-6 leading-5">
          Each batch:&nbsp;
          <span className="text-content-secondary font-medium">{depthDraft}</span> announced move{depthDraft === 1 ? '' : 's'},
          each followed by <span className="text-content-secondary font-medium">{questionsDraft}</span> question{questionsDraft === 1 ? '' : 's'} about the imagined position
          ({depthDraft * questionsDraft} questions total before the board catches up).
          {depthDraft >= 5 ? ' Heavy blindfold practice.' : ''}
        </p>

        <div className="flex items-center justify-between gap-3">
          <Link
            to="/tools"
            className="px-4 py-2 rounded-lg bg-bg-elevated border border-border text-content-secondary text-sm hover:text-content-primary flex items-center gap-1.5"
          >
            <Icon path={mdiArrowLeft} size={0.7} />
            Tools
          </Link>
          <button
            onClick={onStart}
            className="px-5 py-2 rounded-lg bg-accent text-bg-base font-medium hover:bg-accent-hover flex items-center gap-1.5"
          >
            Start session
            <Icon path={mdiPlay} size={0.7} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Switch-style toggle row used for boolean settings ────────────────────
function SettingToggle({
  label, hint, value, onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-content-primary text-sm font-medium">{label}</div>
        <div className="text-content-muted text-xs mt-0.5">{hint}</div>
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
        aria-label={label}
        className={`relative w-11 h-6 rounded-full border transition-colors shrink-0 ${
          value ? 'bg-accent/30 border-accent/60' : 'bg-bg-base border-border'
        }`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${
            value ? 'left-[22px] bg-accent' : 'left-0.5 bg-content-muted'
          }`}
        />
      </button>
    </div>
  );
}

// ── Custom number input (text field + custom +/- buttons) ────────────────
//
// Plain <input type="number"> has ugly native spinners and trips on typed
// values that don't immediately commit. This wraps a text field with hand-
// rolled buttons that update on every keystroke (clamped) and support
// typed-then-click-Start flows by always reflecting the live value.
function NumberInput({
  value, min, max, onChange, ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(String(value));

  // Keep the text in sync when value changes externally (e.g., slider).
  useEffect(() => {
    setDraft((cur) => {
      const parsed = parseInt(cur, 10);
      if (Number.isFinite(parsed) && parsed === value) return cur;
      return String(value);
    });
  }, [value]);

  function clamp(n: number): number {
    return clampToRange(n, min, max);
  }

  function commitFromText(raw: string) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      const clamped = clamp(parsed);
      onChange(clamped);
      setDraft(String(clamped));
    } else {
      setDraft(String(value));
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    setDraft(raw);
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      const clamped = clamp(parsed);
      if (clamped !== value) onChange(clamped);
    }
  }

  function bump(delta: number) {
    onChange(clamp(value + delta));
  }

  return (
    <div className="flex items-stretch bg-bg-base border border-border rounded-md overflow-hidden h-9">
      <button
        type="button"
        onClick={() => bump(-1)}
        disabled={value <= min}
        className="px-2 text-content-secondary hover:text-content-primary hover:bg-bg-elevated disabled:opacity-30 disabled:hover:bg-transparent transition-colors border-r border-border"
        aria-label={`Decrease ${ariaLabel}`}
      >
        <Icon path={mdiMinus} size={0.65} />
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={draft}
        onChange={handleChange}
        onBlur={(e) => commitFromText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'ArrowUp')   { e.preventDefault(); bump(1); }
          if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1); }
        }}
        className="w-12 bg-transparent text-content-primary text-center text-sm focus:outline-none focus:bg-bg-surface"
        aria-label={ariaLabel}
      />
      <button
        type="button"
        onClick={() => bump(1)}
        disabled={value >= max}
        className="px-2 text-content-secondary hover:text-content-primary hover:bg-bg-elevated disabled:opacity-30 disabled:hover:bg-transparent transition-colors border-l border-border"
        aria-label={`Increase ${ariaLabel}`}
      >
        <Icon path={mdiPlus} size={0.65} />
      </button>
    </div>
  );
}

// ── Trainer layout ────────────────────────────────────────────────────────
type LayoutProps = {
  phase: Exclude<Phase, SetupPhase | { kind: 'end' }>;
  score: Score;
  depth: number;
  orientation: BoardOrientation;
  showCoords: boolean;
  showAnnounceIndicators: boolean;
  showQuestionFocus: boolean;
  openingName: string;
  positionCount: number;
  onSquareClick: (a: { square: string | null }) => void;
  onStaticSubmit: () => void;
  onStaticNext: () => void;
  onTogglePeek: () => void;
  onAnnounceNext: () => void;
  onReviewNext: () => void;
  onEndSession: () => void;
};

// Notation labels (a–h, 1–8) at a responsive size: shrink on tight viewports
// without disappearing, cap so they never dominate a desktop board.
const COORD_NOTATION_STYLE: CSSProperties = {
  fontSize: 'clamp(8px, 1.8vmin, 13px)',
  fontWeight: 600,
};

function TrainerLayout(p: LayoutProps) {
  const { colors } = useColorTheme();
  const view = useBoardState(p);

  // The visualized-moves panel is hidden by default — the player has to remember
  // the announced moves themselves. It only renders (a) during review and (b)
  // while peeking on a wrong-answer feedback in a static question.
  const showList =
    (p.phase.kind === 'static' && p.phase.peeking) || p.phase.kind === 'review';
  const listMoves =
    p.phase.kind === 'static' || p.phase.kind === 'review'
      ? p.phase.visualizedMoves
      : [];

  return (
    <div className="flex-1 flex flex-col p-3 lg:p-6 gap-2 lg:gap-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap max-w-[1200px] w-full mx-auto">
        <Link to="/tools" className="flex items-center gap-1 text-content-secondary hover:text-content-primary text-sm">
          <Icon path={mdiArrowLeft} size={0.7} />
          Tools
        </Link>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2.5 py-1 rounded-md bg-bg-surface border border-border text-content-secondary flex items-center gap-1.5">
            <Icon path={mdiEye} size={0.6} className="text-accent" />
            Depth: <span className="text-content-primary font-medium">{p.depth}</span>
          </span>
          <button
            onClick={p.onEndSession}
            className="text-xs px-3 py-1.5 rounded-md bg-bg-elevated text-content-secondary hover:text-content-primary border border-border flex items-center gap-1"
            title="End session and see summary"
          >
            <Icon path={mdiStopCircleOutline} size={0.65} />
            End
          </button>
        </div>
      </div>

      {/* Score strip */}
      <ScoreStrip score={p.score} openingName={p.openingName} positionCount={p.positionCount} />

      {/* Main column */}
      <div className="flex-1 flex flex-col items-center gap-2 lg:gap-3 max-w-[720px] w-full mx-auto">
        {view.prompt && <PromptBanner text={view.prompt} helper={view.helper} />}

        <div
          style={{
            // dvh (dynamic viewport height) accounts for mobile browser chrome.
            // Reserved-chrome estimate covers the AppShell (mobile header,
            // banner ad, bottom nav) plus the trainer header/prompt/footer.
            width: 'min(calc(100vw - 24px), calc(100dvh - 320px), 600px)',
            aspectRatio: '1 / 1',
            position: 'relative',
          }}
        >
          <BoardErrorBoundary resetKey={view.boardFen}>
            <Chessboard
              options={{
                position: view.boardFen,
                boardOrientation: p.orientation === 'b' ? 'black' : 'white',
                allowDragging: false,
                animationDurationInMs: 240,
                boardStyle: { borderRadius: '8px', boxShadow: '0 4px 20px rgba(0,0,0,0.3)' },
                darkSquareStyle: { backgroundColor: colors.board.dark },
                lightSquareStyle: { backgroundColor: colors.board.light },
                squareStyles: view.squareStyles,
                arrows: view.arrows,
                onSquareClick: p.onSquareClick,
                showNotation: p.showCoords,
                // Scale with the board: react-chessboard's notation defaults
                // are fixed px sizes that overflow on small viewports.
                alphaNotationStyle: COORD_NOTATION_STYLE,
                darkSquareNotationStyle: COORD_NOTATION_STYLE,
                lightSquareNotationStyle: COORD_NOTATION_STYLE,
                numericNotationStyle: COORD_NOTATION_STYLE,
              }}
            />
          </BoardErrorBoundary>
        </div>

        {view.footer}

        {/* Visualized moves panel — hidden except when peeking or in review.
         * Placed AFTER the footer so toggling peek doesn't shift the buttons. */}
        {showList && <VisualizedList moves={listMoves} />}
      </div>
    </div>
  );
}

// ── Visualized moves panel ────────────────────────────────────────────────
function VisualizedList({ moves }: { moves: MovePreview[] }) {
  const text = moves.length > 0 ? moves.map((m, i) => `${i + 1}. ${m.san}`).join('  ') : null;
  return (
    <div className="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2">
      <div className="text-content-muted text-[10px] uppercase tracking-wide mb-1">Visualized moves</div>
      {text ? (
        <div className="font-mono text-content-primary text-sm">{text}</div>
      ) : (
        <div className="text-content-muted text-xs">No moves visualized yet.</div>
      )}
    </div>
  );
}

// ── Board state derivation ────────────────────────────────────────────────
function useBoardState(p: LayoutProps): {
  boardFen: string;
  squareStyles: Record<string, CSSProperties>;
  arrows: { startSquare: string; endSquare: string; color: string }[];
  prompt: string | null;
  helper: string | null;
  footer: ReactNode;
} {
  const focusBg = 'rgb(var(--color-gold) / 0.40)';
  const focusRing = 'inset 0 0 0 3px rgb(var(--color-gold) / 0.95)';
  const selectedBg = 'rgb(var(--color-accent) / 0.50)';
  const selectedRing = 'inset 0 0 0 3px rgb(var(--color-accent))';
  const correctBg = 'rgb(var(--color-success) / 0.55)';
  const missedBg = 'rgba(245, 158, 11, 0.55)';
  const wrongBg = 'rgb(var(--color-danger) / 0.55)';

  switch (p.phase.kind) {
    case 'loading':
      return {
        boardFen: 'start',
        squareStyles: {},
        arrows: [],
        prompt: null,
        helper: null,
        footer: (
          <div className="flex items-center gap-2 text-content-secondary text-sm">
            <span className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            {p.phase.message}
          </div>
        ),
      };

    case 'static': {
      const q = p.phase.questions[p.phase.qIndex];
      const verdict = p.phase.verdict;
      const peeking = p.phase.peeking;
      const styles: Record<string, CSSProperties> = {};
      // Focus highlight on the target square is gated by the user pref:
      // when off, the player has to find the target purely from the prompt.
      // It's always shown once a verdict is in so the player can read the
      // green/orange/red feedback in context.
      const showFocus = p.showQuestionFocus || verdict != null;
      if (showFocus) {
        for (const f of q.focusSquares) {
          styles[f] = { backgroundColor: focusBg, boxShadow: focusRing };
        }
      }
      if (verdict == null) {
        for (const s of p.phase.selected) {
          styles[s] = {
            ...(styles[s] ?? {}),
            backgroundColor: selectedBg,
            boxShadow: (styles[s]?.boxShadow as string | undefined)
              ? `${styles[s]?.boxShadow}, ${selectedRing}`
              : selectedRing,
          };
        }
      } else {
        for (const s of verdict.correct) styles[s] = { backgroundColor: correctBg };
        for (const s of verdict.missed) styles[s] = { backgroundColor: missedBg };
        for (const s of verdict.wrong) styles[s] = { backgroundColor: wrongBg };
        for (const f of q.focusSquares) {
          styles[f] = { ...(styles[f] ?? {}), boxShadow: focusRing };
        }
      }
      const helperBits: string[] = [
        `Question ${p.phase.qIndex + 1} / ${p.phase.questions.length}`,
      ];
      if (p.phase.depth > 1) {
        helperBits.push(`Cycle ${p.phase.cycleIndex} / ${p.phase.depth}`);
      }
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
            onSubmit={p.onStaticSubmit}
            onNext={p.onStaticNext}
            onTogglePeek={p.onTogglePeek}
          />
        ),
      };
    }

    case 'announce': {
      const m = p.phase.announcement;
      const fullCycleLabel = p.phase.depth > 1 ? ` (cycle ${p.phase.cycleIndex} / ${p.phase.depth})` : '';
      // Make whose turn it is unambiguous: ellipsis prefix for black + side label.
      const isBlack = m.pieceColor === 'b';
      const sanWithEllipsis = isBlack ? `…${m.san}` : m.san;
      const sideLabel = isBlack ? 'Black' : 'White';
      // Optional on-board indicators (gated by the user pref): focus highlight
      // on the from-square + accent ring on the to-square + an arrow between.
      const styles: Record<string, CSSProperties> = {};
      const arrows: { startSquare: string; endSquare: string; color: string }[] = [];
      if (p.showAnnounceIndicators) {
        styles[m.from] = { backgroundColor: focusBg, boxShadow: focusRing };
        styles[m.to]   = { boxShadow: 'inset 0 0 0 3px rgb(var(--color-accent) / 0.95)' };
        arrows.push({ startSquare: m.from, endSquare: m.to, color: 'rgb(var(--color-accent))' });
      }
      return {
        boardFen: p.phase.visibleFen,
        squareStyles: styles,
        arrows,
        prompt: `Move played: ${sanWithEllipsis} (${sideLabel})${fullCycleLabel}`,
        helper: 'Read the move, picture it in your head, then click Next.',
        footer: (
          <div className="w-full flex items-center justify-end">
            <button
              onClick={p.onAnnounceNext}
              className="px-5 py-2 rounded-lg bg-accent text-bg-base font-medium hover:bg-accent-hover transition-colors flex items-center gap-1.5"
            >
              Next
              <Icon path={mdiChevronRight} size={0.7} />
            </button>
          </div>
        ),
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
          <div className="w-full flex items-center justify-end">
            <button
              onClick={p.onReviewNext}
              className="px-5 py-2 rounded-lg bg-accent text-bg-base font-medium hover:bg-accent-hover transition-colors flex items-center gap-1.5"
            >
              Continue
              <Icon path={mdiChevronRight} size={0.7} />
            </button>
          </div>
        ),
      };
    }
  }
}

// ── UI bits ───────────────────────────────────────────────────────────────
function PromptBanner({ text, helper }: { text: string; helper: string | null }) {
  return (
    <div className="w-full bg-bg-surface border border-border rounded-lg lg:rounded-xl px-3 py-2 lg:p-3">
      <p className="text-content-primary text-sm md:text-base leading-snug lg:leading-6">{text}</p>
      {helper && <p className="text-content-muted text-xs mt-0.5 lg:mt-1 leading-snug lg:leading-5">{helper}</p>}
    </div>
  );
}

function StaticFooter({
  verdict, selCount, qIndex, total, cycleIndex, depth, peeking, onSubmit, onNext, onTogglePeek,
}: {
  verdict: AnswerVerdict | null;
  selCount: number;
  qIndex: number;
  total: number;
  cycleIndex: number;
  depth: number;
  peeking: boolean;
  onSubmit: () => void;
  onNext: () => void;
  onTogglePeek: () => void;
}) {
  if (verdict == null) {
    return (
      <div className="w-full flex items-center justify-between gap-3">
        <span className="text-xs text-content-muted">{selCount} selected</span>
        <button
          onClick={onSubmit}
          className="px-4 py-2 rounded-lg bg-accent text-bg-base font-medium hover:bg-accent-hover transition-colors flex items-center gap-1.5"
        >
          Submit
          <Icon path={mdiCheck} size={0.7} />
        </button>
      </div>
    );
  }
  const isLastInCycle = qIndex + 1 >= total;
  const isLastCycle = cycleIndex >= depth;
  const nextLabel = isLastInCycle
    ? isLastCycle
      ? 'Apply moves'
      : 'Next move'
    : 'Next question';
  // Peek escape hatch: only after a wrong answer. Click reveals both the
  // visualized move list and the actual imagined position on the board.
  const showPeek = !verdict.isPerfect;
  return (
    <div className="w-full flex items-center justify-between gap-3 flex-wrap">
      <VerdictPill verdict={verdict} />
      <div className="flex items-center gap-2">
        {showPeek && (
          <button
            onClick={onTogglePeek}
            className={`text-xs px-2.5 py-1.5 rounded-md border flex items-center gap-1.5 transition-colors ${
              peeking
                ? 'bg-accent/15 border-accent/50 text-accent'
                : 'bg-bg-surface border-border text-content-secondary hover:text-content-primary hover:border-accent/40'
            }`}
            title={peeking ? 'Hide moves and return to the frozen position' : 'Show the visualized moves and the imagined position'}
          >
            <Icon path={mdiEye} size={0.6} />
            {peeking ? 'Hide' : 'Peek'}
          </button>
        )}
        <button
          onClick={onNext}
          className="px-4 py-2 rounded-lg bg-accent text-bg-base font-medium hover:bg-accent-hover transition-colors flex items-center gap-1.5"
        >
          {nextLabel}
          <Icon path={mdiChevronRight} size={0.7} />
        </button>
      </div>
    </div>
  );
}

function VerdictPill({ verdict }: { verdict: AnswerVerdict }) {
  if (verdict.isPerfect) {
    return (
      <span className="text-xs text-success bg-success/10 border border-success/30 rounded-md px-2 py-1 flex items-center gap-1">
        <Icon path={mdiCheck} size={0.6} />
        Perfect — all {verdict.correct.length} squares
      </span>
    );
  }
  return (
    <span className="text-xs text-content-secondary bg-bg-elevated border border-border rounded-md px-2 py-1 flex items-center gap-2">
      <span className="text-success">{verdict.correct.length} ✓</span>
      <span style={{ color: 'rgb(245, 158, 11)' }}>{verdict.missed.length} missed</span>
      <span className="text-danger">{verdict.wrong.length} ✗</span>
    </span>
  );
}

function ScoreStrip({ score, openingName, positionCount }: { score: Score; openingName: string; positionCount: number }) {
  const total = score.correctSquares + score.wrongSquares + score.missedSquares;
  const pct = total === 0 ? null : Math.round((score.correctSquares / total) * 100);
  return (
    <div className="max-w-[1200px] w-full mx-auto flex items-center justify-between text-xs text-content-muted gap-2 px-1 min-w-0">
      <span className="truncate min-w-0 flex-1">
        {openingName && <span className="text-content-secondary">{openingName}</span>}
        {positionCount > 0 && <span className="ml-2 opacity-60">Position {positionCount}</span>}
      </span>
      <span className="flex items-center gap-2 lg:gap-3 shrink-0">
        {score.questionsAnswered > 0 && (
          <>
            <span>{score.perfectAnswers} ✓</span>
            {pct != null && <span className="text-content-secondary">{pct}%</span>}
          </>
        )}
      </span>
    </div>
  );
}

function SessionEndScreen({ score, onRestart }: { score: Score; onRestart: () => void }) {
  const total = score.correctSquares + score.wrongSquares + score.missedSquares;
  const pct = total === 0 ? 0 : Math.round((score.correctSquares / total) * 100);
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full bg-bg-surface border border-border rounded-2xl p-8 text-center">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-accent/10 text-accent flex items-center justify-center mb-4">
          <Icon path={mdiEye} size={1.1} />
        </div>
        <h2 className="text-content-primary text-xl font-semibold mb-1">Session ended</h2>
        <p className="text-content-secondary text-sm mb-6">Nice work tracking that piece vision.</p>

        <div className="grid grid-cols-2 gap-3 mb-6">
          <Stat label="Questions" value={score.questionsAnswered} />
          <Stat label="Perfect" value={score.perfectAnswers} />
          <Stat label="Squares correct" value={score.correctSquares} />
          <Stat label="Accuracy" value={`${pct}%`} />
        </div>

        <div className="flex items-center justify-center gap-3">
          <Link
            to="/tools"
            className="px-4 py-2 rounded-lg bg-bg-elevated border border-border text-content-secondary text-sm hover:text-content-primary flex items-center gap-1.5"
          >
            <Icon path={mdiArrowLeft} size={0.7} />
            Tools
          </Link>
          <button
            onClick={onRestart}
            className="px-4 py-2 rounded-lg bg-accent text-bg-base font-medium hover:bg-accent-hover flex items-center gap-1.5"
          >
            <Icon path={mdiRefresh} size={0.7} />
            New session
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-bg-base border border-border rounded-lg px-3 py-3">
      <div className="text-content-primary text-lg font-semibold">{value}</div>
      <div className="text-content-muted text-xs">{label}</div>
    </div>
  );
}
