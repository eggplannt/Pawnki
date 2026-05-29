import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  View,
  Image,
  Pressable,
  Text,
  type ImageSourcePropType,
  type LayoutChangeEvent,
  ViewStyle,
  StyleProp,
} from 'react-native';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Chess } from 'chess.js';
import { Asset } from 'expo-asset';
import { useColorTheme } from '@/hooks/useColorTheme';

// Lichess cburnett piece set (GPLv2+, Colin M.L. Burnett)
const PIECES: Record<string, ImageSourcePropType> = {
  K: require('@/assets/pieces/wK.png'),
  Q: require('@/assets/pieces/wQ.png'),
  R: require('@/assets/pieces/wR.png'),
  B: require('@/assets/pieces/wB.png'),
  N: require('@/assets/pieces/wN.png'),
  P: require('@/assets/pieces/wP.png'),
  k: require('@/assets/pieces/bK.png'),
  q: require('@/assets/pieces/bQ.png'),
  r: require('@/assets/pieces/bR.png'),
  b: require('@/assets/pieces/bB.png'),
  n: require('@/assets/pieces/bN.png'),
  p: require('@/assets/pieces/bP.png'),
};

// Decode all piece bitmaps once on module load — otherwise the first board
// renders piece-by-piece as each <Image> is decoded for the first time.
Asset.loadAsync(Object.values(PIECES) as number[]).catch(() => {});

const MOVE_ANIM_MS = 180;
const DRAG_BACK_MS = 150;
// On a legal drop we glide pos/drag to the target instead of snapping
// instantly — the animation duration acts as a buffer that gives the parent's
// React commit a chance to remove the captured piece (and unmount stale
// indicators) before the dragged piece visually arrives.
const DROP_SETTLE_MS = 120;
const INDICATOR_FADE_MS = 80;
const DRAG_SCALE = 1.15;
const SCALE_ANIM_MS = 80;

// ── FEN + square helpers ─────────────────────────────────────────────────

function parseFen(fen: string): (string | null)[][] {
  const rows = fen.split(' ')[0].split('/');
  return rows.map((row) => {
    const squares: (string | null)[] = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < parseInt(ch, 10); i++) squares.push(null);
      } else {
        squares.push(ch);
      }
    }
    return squares;
  });
}

function squareId(row: number, col: number): string {
  return `${String.fromCharCode(97 + col)}${8 - row}`;
}

function squareToRowCol(sq: string): { row: number; col: number } {
  return { col: sq.charCodeAt(0) - 97, row: 8 - parseInt(sq[1], 10) };
}

function squareToPixels(
  sq: string,
  squareSize: number,
  orientation: 'white' | 'black',
): { x: number; y: number } {
  const { row, col } = squareToRowCol(sq);
  const vCol = orientation === 'white' ? col : 7 - col;
  const vRow = orientation === 'white' ? row : 7 - row;
  return { x: vCol * squareSize, y: vRow * squareSize };
}

function pieceColor(p: string): 'w' | 'b' {
  return p === p.toUpperCase() ? 'w' : 'b';
}

// ── Piece tracking ───────────────────────────────────────────────────────

interface PieceInstance {
  id: string;
  type: string;     // 'K', 'q', ...
  square: string;   // 'e4', ...
}

const nextPieceId = (() => {
  let n = 0;
  return () => `p${++n}`;
})();

function initialPieces(fen: string): PieceInstance[] {
  const board = parseFen(fen);
  const out: PieceInstance[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r]?.[c];
      if (p) out.push({ id: nextPieceId(), type: p, square: squareId(r, c) });
    }
  }
  return out;
}

/**
 * Match existing piece identities to a new FEN: each piece keeps its identity
 * by claiming the nearest unoccupied same-type new square. Unmatched old
 * pieces are dropped (captured); unmatched new squares get fresh instances.
 */
function reconcilePieces(oldPieces: PieceInstance[], newFen: string): PieceInstance[] {
  const newBoard = parseFen(newFen);
  const newByType = new Map<string, string[]>();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = newBoard[r]?.[c];
      if (p) {
        const list = newByType.get(p) ?? [];
        list.push(squareId(r, c));
        newByType.set(p, list);
      }
    }
  }

  const used = new Set<string>();
  const matched = new Map<string, string>();

  for (const oldP of oldPieces) {
    const list = newByType.get(oldP.type);
    if (list && list.includes(oldP.square) && !used.has(oldP.square)) {
      matched.set(oldP.id, oldP.square);
      used.add(oldP.square);
    }
  }

  for (const oldP of oldPieces) {
    if (matched.has(oldP.id)) continue;
    const list = newByType.get(oldP.type);
    if (!list) continue;
    const o = squareToRowCol(oldP.square);
    let bestSq: string | null = null;
    let bestDist = Infinity;
    for (const sq of list) {
      if (used.has(sq)) continue;
      const n = squareToRowCol(sq);
      const d = Math.abs(o.row - n.row) + Math.abs(o.col - n.col);
      if (d < bestDist) { bestDist = d; bestSq = sq; }
    }
    if (bestSq) {
      matched.set(oldP.id, bestSq);
      used.add(bestSq);
    }
  }

  const result: PieceInstance[] = [];
  for (const oldP of oldPieces) {
    const sq = matched.get(oldP.id);
    if (!sq) continue;
    // Preserve object identity when nothing changed so memo'd children skip
    // re-rendering (and their effects don't refire).
    result.push(sq === oldP.square ? oldP : { ...oldP, square: sq });
  }
  for (const [type, squares] of newByType) {
    for (const sq of squares) {
      if (!used.has(sq)) result.push({ id: nextPieceId(), type, square: sq });
    }
  }
  return result;
}

// ── AnimatedPiece ────────────────────────────────────────────────────────

interface AnimatedPieceProps {
  piece: PieceInstance;
  squareSize: number;
  orientation: 'white' | 'black';
  onTap: (square: string) => void;
  onDragStart: (square: string) => void;
  onDrop: (from: string, to: string | null, wasLegal: boolean) => void;
  /** Worklet-readable map of legal target squares for the currently-selected
   *  piece — used by drop's onEnd to decide between optimistic snap and
   *  animate-back. */
  legalTargetsSV: { value: Record<string, boolean> };
  /** 1 = indicators visible; 0 = hidden. Worklet sets to 0 on drop so the next
   *  render frame doesn't briefly show stale indicators while React processes
   *  the deselect. */
  indicatorsVisibleSV: { value: number };
  /** Whose side may currently drag: 'w', 'b', or '' (no drag — board disabled).
   *  Passing this as a shared value avoids rebuilding all 32 gesture closures
   *  every time side-to-move flips. */
  dragSideSV: { value: 'w' | 'b' | '' };
}

export interface AnimatedPieceHandle {
  /** Animate piece back to a square (used to roll back when the parent
   *  rejects a chess-legal move). */
  animateTo: (square: string) => void;
}

const AnimatedPiece = memo(forwardRef<AnimatedPieceHandle, AnimatedPieceProps>(function AnimatedPiece({
  piece,
  squareSize,
  orientation,
  onTap,
  onDragStart,
  onDrop,
  legalTargetsSV,
  indicatorsVisibleSV,
  dragSideSV,
}, ref) {
  const initial = useMemo(
    () => squareToPixels(piece.square, squareSize, orientation),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // posX/posY: the piece's "logical" pixel position, animated when its square
  // changes. dragX/dragY: live drag offset relative to posX/posY (0 at rest).
  // Visual translate = posX + dragX, posY + dragY.
  const posX = useSharedValue(initial.x);
  const posY = useSharedValue(initial.y);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const scale = useSharedValue(1);
  const elevated = useSharedValue(0); // 0/1: drives zIndex, decoupled from scale anim
  // Set to 1 while a legal drop-settle animation is in flight so onFinalize
  // doesn't prematurely reset elevated (onFinalize fires right after onEnd).
  const isSettling = useSharedValue(0);
  // desiredX/Y mirror the piece's logical square's visual pos. The
  // worklet-driven drop-settle / drag-back animations consult these when they
  // finish, in case piece.square changed during the animation (e.g., learn
  // mode fast-forward jumps the FEN to a position where the just-moved piece
  // sits on a different square than where the user dropped it).
  const desiredX = useSharedValue(initial.x);
  const desiredY = useSharedValue(initial.y);

  // Finger-offset from piece center captured on drag start so we can recenter
  // the piece under the touch point (the touch may have landed anywhere on
  // the piece view).
  const grabOffsetX = useSharedValue(0);
  const grabOffsetY = useSharedValue(0);

  // Animate to the new logical square whenever the piece's square or board
  // geometry changes. Skip if elevated — drag or drop-settle is in flight and
  // owns the visual; the settle's onFinish callback will catch up to the
  // (just-updated) desiredX/Y if needed.
  useEffect(() => {
    const t = squareToPixels(piece.square, squareSize, orientation);
    desiredX.value = t.x;
    desiredY.value = t.y;
    if (elevated.value === 1) return;
    posX.value = withTiming(t.x, { duration: MOVE_ANIM_MS });
    posY.value = withTiming(t.y, { duration: MOVE_ANIM_MS });
  }, [piece.square, squareSize, orientation, posX, posY, desiredX, desiredY, elevated]);

  const isWhiteOrient = orientation === 'white';
  const pieceSquare = piece.square;
  const pColor: 'w' | 'b' = pieceColor(piece.type);

  const composed = useMemo(() => {
    const tap = Gesture.Tap()
      .maxDuration(250)
      .onEnd(() => {
        'worklet';
        runOnJS(onTap)(pieceSquare);
      });

    const pan = Gesture.Pan()
      .minDistance(4)
      .onStart((e) => {
        'worklet';
        if (dragSideSV.value !== pColor) return;
        cancelAnimation(posX);
        cancelAnimation(posY);
        // Snap posX/Y to the piece's exact logical square so the recenter math
        // below has a known reference. Without this, a mid-flight withTiming
        // would leave posX between squares and the piece would jump on touch.
        const sq = pieceSquare;
        const col = sq.charCodeAt(0) - 97;
        const row = 8 - parseInt(sq.charAt(1), 10);
        const vCol = isWhiteOrient ? col : 7 - col;
        const vRow = isWhiteOrient ? row : 7 - row;
        posX.value = vCol * squareSize;
        posY.value = vRow * squareSize;

        grabOffsetX.value = e.x - squareSize / 2;
        grabOffsetY.value = e.y - squareSize / 2;
        dragX.value = grabOffsetX.value;
        dragY.value = grabOffsetY.value;

        elevated.value = 1;
        scale.value = withTiming(DRAG_SCALE, { duration: SCALE_ANIM_MS });
        indicatorsVisibleSV.value = 1;
        runOnJS(onDragStart)(pieceSquare);
      })
      .onUpdate((e) => {
        'worklet';
        if (dragSideSV.value !== pColor) return;
        dragX.value = grabOffsetX.value + e.translationX;
        dragY.value = grabOffsetY.value + e.translationY;
      })
      .onEnd((e) => {
        'worklet';
        if (dragSideSV.value !== pColor) return;
        // Drop target = the square the finger is over. Piece visual center =
        // posX + dragX + squareSize/2; since posX is the logical-square pos
        // (clamped in onStart), this is just the finger position in board
        // coords.
        const centerX = posX.value + grabOffsetX.value + e.translationX + squareSize / 2;
        const centerY = posY.value + grabOffsetY.value + e.translationY + squareSize / 2;
        const vCol = Math.floor(centerX / squareSize);
        const vRow = Math.floor(centerY / squareSize);
        let target: string | null = null;
        if (vCol >= 0 && vCol < 8 && vRow >= 0 && vRow < 8) {
          const col = isWhiteOrient ? vCol : 7 - vCol;
          const row = isWhiteOrient ? vRow : 7 - vRow;
          target = `${String.fromCharCode(97 + col)}${8 - row}`;
        }

        const isLegal = !!(target && target !== pieceSquare && legalTargetsSV.value[target]);

        scale.value = withTiming(1, { duration: SCALE_ANIM_MS });

        if (isLegal && target) {
          // Glide posX/Y to the target and dragX/Y to 0 over DROP_SETTLE_MS.
          // The animation duration is the buffer that lets React commit the
          // FEN (and remove any captured piece) before the dragged piece
          // visually arrives — avoiding the brief two-pieces-on-one-square
          // overlap that a hard snap caused.
          const targetX = vCol * squareSize;
          const targetY = vRow * squareSize;
          // Mark settle in-flight so onFinalize (which fires right after onEnd)
          // doesn't prematurely reset elevated and let the useEffect interfere.
          isSettling.value = 1;
          posX.value = withTiming(targetX, { duration: DROP_SETTLE_MS });
          posY.value = withTiming(targetY, { duration: DROP_SETTLE_MS });
          dragX.value = withTiming(0, { duration: DROP_SETTLE_MS });
          dragY.value = withTiming(0, { duration: DROP_SETTLE_MS }, (finished) => {
            'worklet';
            isSettling.value = 0;
            if (!finished) return;
            elevated.value = 0;
            // If piece.square shifted during the settle (e.g., learn-mode
            // fast-forward FEN jump), catch up to the new logical square.
            if (posX.value !== desiredX.value || posY.value !== desiredY.value) {
              posX.value = withTiming(desiredX.value, { duration: MOVE_ANIM_MS });
              posY.value = withTiming(desiredY.value, { duration: MOVE_ANIM_MS });
            }
          });
          // Fade indicators rather than yanking them — covers the gap between
          // worklet end and React unmounting them via the deselect.
          indicatorsVisibleSV.value = withTiming(0, { duration: INDICATOR_FADE_MS });
          // Keep `elevated` = 1 (piece sits on top) during the glide; the
          // animation callback above flips it back to 0 when done.
        } else {
          // Illegal drop (off-board, on source, or not in legal set): glide
          // the piece back to its source square smoothly.
          dragX.value = withTiming(0, { duration: DRAG_BACK_MS });
          dragY.value = withTiming(0, { duration: DRAG_BACK_MS }, (finished) => {
            'worklet';
            if (!finished) return;
            elevated.value = 0;
            if (posX.value !== desiredX.value || posY.value !== desiredY.value) {
              posX.value = withTiming(desiredX.value, { duration: MOVE_ANIM_MS });
              posY.value = withTiming(desiredY.value, { duration: MOVE_ANIM_MS });
            }
          });
          indicatorsVisibleSV.value = withTiming(0, { duration: INDICATOR_FADE_MS });
        }

        runOnJS(onDrop)(pieceSquare, target, isLegal);
      })
      .onFinalize(() => {
        'worklet';
        // Don't reset elevated if a drop-settle is in flight — the settle
        // callback owns the reset. Only reset for cancelled/interrupted gestures.
        if (elevated.value === 1 && isSettling.value === 0) elevated.value = 0;
        scale.value = withTiming(1, { duration: SCALE_ANIM_MS });
      });

    return Gesture.Race(tap, pan);
  }, [
    pieceSquare, squareSize, isWhiteOrient, pColor,
    onTap, onDragStart, onDrop,
    posX, posY, dragX, dragY, scale, elevated, isSettling,
    desiredX, desiredY,
    grabOffsetX, grabOffsetY,
    legalTargetsSV, indicatorsVisibleSV, dragSideSV,
  ]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: posX.value + dragX.value },
      { translateY: posY.value + dragY.value },
      { scale: scale.value },
    ],
    zIndex: elevated.value === 1 ? 100 : 1,
  }));

  useImperativeHandle(ref, () => ({
    animateTo: (square: string) => {
      const t = squareToPixels(square, squareSize, orientation);
      cancelAnimation(posX);
      cancelAnimation(posY);
      cancelAnimation(dragX);
      cancelAnimation(dragY);
      // Keep the piece elevated during the rollback so it draws on top of
      // any other piece momentarily occupying the path.
      elevated.value = 1;
      posX.value = withTiming(t.x, { duration: MOVE_ANIM_MS });
      posY.value = withTiming(t.y, { duration: MOVE_ANIM_MS });
      dragX.value = withTiming(0, { duration: MOVE_ANIM_MS });
      dragY.value = withTiming(0, { duration: MOVE_ANIM_MS }, (finished) => {
        'worklet';
        if (finished) elevated.value = 0;
      });
    },
  }), [squareSize, orientation, posX, posY, dragX, dragY, elevated]);

  return (
    <GestureDetector gesture={composed}>
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: 0,
            top: 0,
            width: squareSize,
            height: squareSize,
            alignItems: 'center',
            justifyContent: 'center',
          },
          animStyle,
        ]}
      >
        <Image
          source={PIECES[piece.type]}
          style={{ width: '85%', height: '85%' }}
          resizeMode="contain"
        />
      </Animated.View>
    </GestureDetector>
  );
}));

// ── Legal-target indicator ───────────────────────────────────────────────

const LegalTargetIndicator = memo(function LegalTargetIndicator({
  square, isCapture, squareSize, orientation, color, visibleSV,
}: {
  square: string;
  isCapture: boolean;
  squareSize: number;
  orientation: 'white' | 'black';
  color: string;
  visibleSV: { value: number };
}) {
  const { x, y } = squareToPixels(square, squareSize, orientation);
  const style = useAnimatedStyle(() => ({ opacity: visibleSV.value }));
  const inner: ViewStyle = isCapture
    ? {
        width: squareSize * 0.92,
        height: squareSize * 0.92,
        borderRadius: 999,
        borderWidth: Math.max(2, squareSize * 0.08),
        borderColor: color,
      }
    : {
        width: squareSize * 0.3,
        height: squareSize * 0.3,
        borderRadius: 999,
        backgroundColor: color,
      };
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: x,
          top: y,
          width: squareSize,
          height: squareSize,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <View style={inner} />
    </Animated.View>
  );
});

// ── BoardSquares ─────────────────────────────────────────────────────────

// Static (selection-independent) square grid: backgrounds, optional tint
// overlays from `squareStyles`, and tap-to-deselect / tap-to-target presses.
// Memoized so selection state changes don't re-render 64 Pressables.
const BoardSquares = memo(function BoardSquares({
  rows, cols, lightColor, darkColor, squareStyles, onSquareTap, disabled,
  showNotation, notationFontSize,
}: {
  rows: number[];
  cols: number[];
  lightColor: string;
  darkColor: string;
  squareStyles?: Record<string, StyleProp<ViewStyle>>;
  onSquareTap: (sq: string) => void;
  disabled: boolean;
  showNotation: boolean;
  /** Used to scale notation labels to the actual square size. 0 until measured. */
  notationFontSize: number;
}) {
  const bottomRow = rows[rows.length - 1];
  const leftCol = cols[0];
  return (
    <>
      {rows.map((row) => (
        <View key={row} style={{ flex: 1, flexDirection: 'row' }}>
          {cols.map((col) => {
            const isLight = (row + col) % 2 === 0;
            const sq = squareId(row, col);
            const extra = squareStyles ? squareStyles[sq] : null;
            // Coordinate label color: contrasts with the square.
            const labelColor = isLight ? darkColor : lightColor;
            const showFile = showNotation && row === bottomRow;
            const showRank = showNotation && col === leftCol;
            return (
              <Pressable
                key={col}
                onPress={() => onSquareTap(sq)}
                disabled={disabled}
                style={[{ flex: 1, backgroundColor: isLight ? lightColor : darkColor }, extra]}
              >
                {showRank && notationFontSize > 0 && (
                  <Text
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      top: 1,
                      left: 3,
                      color: labelColor,
                      fontSize: notationFontSize,
                      fontWeight: '600',
                      opacity: 0.85,
                    }}
                  >
                    {String(8 - row)}
                  </Text>
                )}
                {showFile && notationFontSize > 0 && (
                  <Text
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      bottom: 1,
                      right: 3,
                      color: labelColor,
                      fontSize: notationFontSize,
                      fontWeight: '600',
                      opacity: 0.85,
                    }}
                  >
                    {String.fromCharCode(97 + col)}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      ))}
    </>
  );
});

// ── Chessboard ───────────────────────────────────────────────────────────

export interface ChessboardMove {
  san: string;
  uci: string;
  fen: string;
  from: string;
  to: string;
}

interface ChessboardProps {
  fen: string;
  orientation?: 'white' | 'black';
  /** Tap-to-move or drag-to-move handler. Return `false` to synchronously
   *  reject a chess-legal move (e.g., wrong line in Practice mode); the board
   *  will roll back any optimistic UI. Return `void`/anything else to defer
   *  to FEN-prop reconciliation. */
  onMove?: (move: ChessboardMove) => unknown;
  /**
   * If provided, the board switches to "tap-to-select" mode: every square tap
   * (whether on a piece or an empty square) fires this callback, and the
   * built-in piece-move logic is bypassed. Used by the Vision Trainer for
   * answer selection. Mutually exclusive with `onMove` in practice.
   */
  onSquareSelect?: (sq: string) => void;
  disabled?: boolean;
  squareStyles?: Record<string, StyleProp<ViewStyle>>;
  darkSquareColor?: string;
  lightSquareColor?: string;
  /** If provided, pieces position immediately on first render instead of
   *  waiting for onLayout. Should match the rendered board width. */
  size?: number;
  /** Overlay arrows drawn from→to. Used to hint at already-practiced lines. */
  arrows?: Array<{ from: string; to: string; color?: string }>;
  /** Render a–h / 1–8 coordinate labels in the corner squares. On by default. */
  showNotation?: boolean;
}

export const Chessboard = memo(function Chessboard({
  fen,
  orientation = 'white',
  onMove,
  onSquareSelect,
  disabled = false,
  darkSquareColor,
  squareStyles,
  lightSquareColor,
  size,
  arrows,
  showNotation = true,
}: ChessboardProps) {
  const { colors: colorTheme } = useColorTheme();
  const resolvedDark = darkSquareColor ?? colorTheme.board.dark;
  const resolvedLight = lightSquareColor ?? colorTheme.board.light;

  // Pieces are derived from FEN synchronously via useMemo (vs. useState +
  // useEffect+setState) so a FEN change costs one render, not two.
  // piecesVersion lets us bump the memo after an optimistic in-place mutation
  // of piecesRef (e.g., on a legal drop) so reconcile sees the dragged piece
  // at its new square — without that, a parent FEN that jumps to a different
  // line could "match" the piece at its stale source square and leave the
  // visual stuck at the drop target.
  const piecesRef = useRef<PieceInstance[]>([]);
  const lastFenForPiecesRef = useRef<string | null>(null);
  const pieceHandlesRef = useRef<Map<string, AnimatedPieceHandle>>(new Map());
  const refSettersRef = useRef<Map<string, (h: AnimatedPieceHandle | null) => void>>(new Map());
  const [piecesVersion, setPiecesVersion] = useState(0);

  const pieces = useMemo(() => {
    if (lastFenForPiecesRef.current === fen) return piecesRef.current;
    const next = lastFenForPiecesRef.current === null
      ? initialPieces(fen)
      : reconcilePieces(piecesRef.current, fen);
    piecesRef.current = next;
    lastFenForPiecesRef.current = fen;
    return next;
  }, [fen, piecesVersion]);

  // Captured piece id, hidden optimistically on a legal capture drop so the
  // captured piece doesn't briefly cover the user's piece while we wait for
  // the parent's FEN update. Cleared on FEN-advance or rollback.
  const [pendingCaptureId, setPendingCaptureId] = useState<string | null>(null);
  useEffect(() => {
    if (pendingCaptureId !== null) setPendingCaptureId(null);
    // We intentionally only watch `fen` — clearing pendingCaptureId is the
    // FEN-advance signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen]);

  const getRefSetter = useCallback((id: string) => {
    const map = refSettersRef.current;
    let fn = map.get(id);
    if (!fn) {
      fn = (h: AnimatedPieceHandle | null) => {
        if (h) pieceHandlesRef.current.set(id, h);
        else pieceHandlesRef.current.delete(id);
      };
      map.set(id, fn);
    }
    return fn;
  }, []);

  const [measuredSize, setMeasuredSize] = useState(0);
  const boardSize = size ?? measuredSize;
  const squareSize = boardSize / 8;

  const interactive = !disabled && !!onMove;
  const selectMode = !!onSquareSelect;
  const sideToMove = fen.split(' ')[1] === 'w' ? 'w' : 'b';

  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { setSelected(null); }, [fen]);

  // Map of legal target square → isCapture. Capture targets render as a ring,
  // empty targets as a dot.
  const legalTargets = useMemo(() => {
    if (!selected) return new Map<string, boolean>();
    try {
      const chess = new Chess(fen);
      const moves = chess.moves({ square: selected as any, verbose: true });
      const out = new Map<string, boolean>();
      for (const m of moves as any[]) {
        const flags = m.flags as string;
        out.set(m.to as string, !!chess.get(m.to as any) || flags.includes('e'));
      }
      return out;
    } catch {
      return new Map<string, boolean>();
    }
  }, [selected, fen]);

  const legalTargetsSV = useSharedValue<Record<string, boolean>>({});
  const indicatorsVisibleSV = useSharedValue(1);
  // Single SV for "whose side may currently drag." All 32 piece gestures
  // read this from their worklets, so flipping side-to-move (or toggling
  // `disabled`) doesn't rebuild a single gesture closure.
  const dragSideSV = useSharedValue<'w' | 'b' | ''>(interactive ? sideToMove : '');
  useEffect(() => {
    dragSideSV.value = interactive ? sideToMove : '';
  }, [interactive, sideToMove, dragSideSV]);
  useEffect(() => {
    const map: Record<string, boolean> = {};
    for (const sq of legalTargets.keys()) map[sq] = true;
    legalTargetsSV.value = map;
    // Only un-hide indicators when there are actually some to show — keeps
    // the worklet's fade-out from being immediately cancelled when the
    // post-drop render sets legalTargets to empty.
    if (legalTargets.size > 0) indicatorsVisibleSV.value = 1;
  }, [legalTargets, legalTargetsSV, indicatorsVisibleSV]);

  // Latest interaction context held in a ref so the callbacks passed to each
  // AnimatedPiece stay referentially stable — otherwise every selection
  // change would re-attach all 32 native GestureDetectors.
  const ctxRef = useRef({ fen, selected, legalTargets, sideToMove, interactive, onMove });
  ctxRef.current = { fen, selected, legalTargets, sideToMove, interactive, onMove };

  // Try the move through chess.js + parent. Returns whether the move is
  // legal, plus the parent's optional acceptance hint (true = accept,
  // false = synchronous reject, undefined = no signal).
  const tryMove = useCallback((from: string, to: string): { legal: boolean; acceptedHint: boolean | undefined } => {
    const ctx = ctxRef.current;
    if (!ctx.interactive) return { legal: false, acceptedHint: undefined };
    try {
      const chess = new Chess(ctx.fen);
      const result = chess.move({ from, to, promotion: 'q' });
      if (result) {
        const ret = ctx.onMove?.({
          san: result.san,
          uci: result.from + result.to + (result.promotion ?? ''),
          fen: chess.fen(),
          from: result.from,
          to: result.to,
        });
        return { legal: true, acceptedHint: typeof ret === 'boolean' ? ret : undefined };
      }
    } catch {
      // chess.js throws on illegal — treat as not-legal.
    }
    return { legal: false, acceptedHint: undefined };
  }, []);

  // Pre-select indicators before render so they don't flash invisible the
  // first frame after selection changes.
  const showIndicatorsNow = useCallback(() => {
    indicatorsVisibleSV.value = 1;
  }, [indicatorsVisibleSV]);

  const handlePieceTap = useCallback((sq: string) => {
    // Select-mode short-circuit: piece tap = tap on its square.
    if (onSquareSelect) { onSquareSelect(sq); return; }
    const { interactive, selected, legalTargets, fen, sideToMove } = ctxRef.current;
    if (!interactive) return;
    if (selected && legalTargets.has(sq) && selected !== sq) {
      tryMove(selected, sq);
      setSelected(null);
      return;
    }
    const board = parseFen(fen);
    const { row, col } = squareToRowCol(sq);
    const p = board[row]?.[col];
    if (p && pieceColor(p) === sideToMove) {
      const next = sq === selected ? null : sq;
      setSelected(next);
      if (next) showIndicatorsNow();
    } else {
      setSelected(null);
    }
  }, [tryMove, showIndicatorsNow, onSquareSelect]);

  const handleSquareTap = useCallback((sq: string) => {
    // Select-mode short-circuit: just relay the tap.
    if (onSquareSelect) { onSquareSelect(sq); return; }
    const { interactive, selected, legalTargets } = ctxRef.current;
    if (!interactive) return;
    if (selected && legalTargets.has(sq)) {
      tryMove(selected, sq);
      setSelected(null);
      return;
    }
    if (selected) setSelected(null);
  }, [tryMove, onSquareSelect]);

  // Drag start: select so legal-target indicators appear. The piece's pan
  // worklet already gated on dragSideSV, so this only fires for the side
  // currently allowed to move.
  const handlePieceDragStart = useCallback((sq: string) => {
    if (!ctxRef.current.interactive) return;
    setSelected(sq);
    showIndicatorsNow();
  }, [showIndicatorsNow]);

  // Drag release. The worklet already:
  //   - on legal: started gliding piece pos to the target square and started
  //     a fade on indicators;
  //   - on illegal: started a smooth animate-back of dragX/Y to 0.
  // Our job in JS: optimistically update the dragged piece's logical square
  // so a subsequent FEN that moves it elsewhere (different-line jump in
  // practice/review) triggers a proper move-animation instead of leaving the
  // piece stuck at the drop target; commit the move; and roll back if the
  // parent rejects.
  const handlePieceDrop = useCallback((from: string, to: string | null, wasLegal: boolean) => {
    if (!ctxRef.current.interactive) {
      setSelected(null);
      return;
    }

    if (!wasLegal || !to || to === from) {
      // Worklet is already animating piece back to source. Nothing to commit.
      setSelected(null);
      return;
    }

    const draggedId = piecesRef.current.find((p) => p.square === from)?.id ?? null;
    const fenBefore = ctxRef.current.fen;

    // Optimistically hide any captured piece on the target. If chess.js
    // rejects the move below, we restore it.
    const captured = piecesRef.current.find((p) => p.square === to && p.id !== draggedId);
    if (captured) setPendingCaptureId(captured.id);

    // Optimistically move the dragged piece's logical square to `to`. The
    // memo bump (piecesVersion) re-runs the pieces computation so reconcile
    // sees the piece at its new position — critical for the case where the
    // parent's next FEN comes from a different line and would otherwise
    // accidentally "match" this piece at its stale source square.
    let didOptimisticMove = false;
    if (draggedId) {
      piecesRef.current = piecesRef.current.map((p) =>
        p.id === draggedId ? { ...p, square: to } : p,
      );
      didOptimisticMove = true;
    }

    setSelected(null);
    if (didOptimisticMove) setPiecesVersion((v) => v + 1);

    const rollback = () => {
      if (draggedId && didOptimisticMove) {
        piecesRef.current = piecesRef.current.map((p) =>
          p.id === draggedId ? { ...p, square: from } : p,
        );
        setPiecesVersion((v) => v + 1);
      }
      if (captured) setPendingCaptureId(null);
      if (draggedId) pieceHandlesRef.current.get(draggedId)?.animateTo(from);
    };

    const { legal, acceptedHint } = tryMove(from, to);

    if (!legal) {
      // Worklet said legal (based on legalTargetsSV) but chess.js disagrees
      // — snapshot mismatch. Roll back optimistic state.
      rollback();
      return;
    }

    if (acceptedHint === false) {
      // Parent rejected synchronously (e.g., wrong line in Practice).
      rollback();
      return;
    }

    if (acceptedHint === true) {
      // Parent confirmed — FEN should advance imminently, reconcile will
      // clear pendingCaptureId.
      return;
    }

    // acceptedHint === undefined: parent didn't signal. Fall back to
    // detecting FEN no-advance, which means rejection.
    requestAnimationFrame(() => {
      if (lastFenForPiecesRef.current === fenBefore) rollback();
    });
  }, [tryMove]);

  function onBoardLayout(e: LayoutChangeEvent) {
    if (size !== undefined) return;
    const w = e.nativeEvent.layout.width;
    if (w !== measuredSize) setMeasuredSize(w);
  }

  const rows = useMemo(
    () => (orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]),
    [orientation],
  );
  const cols = rows;

  const visiblePieces = pendingCaptureId ? pieces.filter((p) => p.id !== pendingCaptureId) : pieces;
  const indicatorEntries = useMemo(() => {
    const out: Array<{ square: string; isCapture: boolean }> = [];
    for (const [sq, isCapture] of legalTargets) out.push({ square: sq, isCapture });
    return out;
  }, [legalTargets]);

  const selectedPx = selected && squareSize > 0
    ? squareToPixels(selected, squareSize, orientation)
    : null;

  return (
    <View
      onLayout={onBoardLayout}
      style={{ aspectRatio: 1, borderRadius: 8, overflow: 'hidden', position: 'relative' }}
    >
      {/* Layer 1: squares — static, selection-independent */}
      <BoardSquares
        rows={rows}
        cols={cols}
        lightColor={resolvedLight}
        darkColor={resolvedDark}
        squareStyles={squareStyles}
        onSquareTap={handleSquareTap}
        disabled={!interactive && !selectMode}
        showNotation={showNotation}
        notationFontSize={Math.max(8, Math.min(13, Math.round(squareSize * 0.22)))}
      />

      {/* Layer 2: selection highlight overlay — separate so toggling
          selection doesn't re-render the 64 squares above. */}
      {selectedPx && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: selectedPx.x,
            top: selectedPx.y,
            width: squareSize,
            height: squareSize,
            backgroundColor: colorTheme.accent.dim,
          }}
        />
      )}

      {/* Layer 3: pieces */}
      {squareSize > 0 && visiblePieces.map((p) => (
        <AnimatedPiece
          key={p.id}
          ref={getRefSetter(p.id)}
          piece={p}
          squareSize={squareSize}
          orientation={orientation}
          onTap={handlePieceTap}
          onDragStart={handlePieceDragStart}
          onDrop={handlePieceDrop}
          legalTargetsSV={legalTargetsSV}
          indicatorsVisibleSV={indicatorsVisibleSV}
          dragSideSV={dragSideSV}
        />
      ))}

      {/* Layer 4: legal-target indicators (above pieces so capture rings sit
          on top of the to-be-captured piece) */}
      {squareSize > 0 && indicatorEntries.map(({ square, isCapture }) => (
        <LegalTargetIndicator
          key={`tgt-${square}`}
          square={square}
          isCapture={isCapture}
          squareSize={squareSize}
          orientation={orientation}
          color={colorTheme.accent.default + 'AA'}
          visibleSV={indicatorsVisibleSV}
        />
      ))}

      {/* Layer 5: arrows (topmost) */}
      {squareSize > 0 && arrows?.map((a, i) => (
        <BoardArrow
          key={`${a.from}-${a.to}-${i}`}
          from={a.from}
          to={a.to}
          squareSize={squareSize}
          orientation={orientation}
          color={a.color ?? colorTheme.danger}
        />
      ))}
    </View>
  );
});

// ── BoardArrow ───────────────────────────────────────────────────────────

const BoardArrow = memo(function BoardArrow({
  from, to, squareSize, orientation, color,
}: {
  from: string;
  to: string;
  squareSize: number;
  orientation: 'white' | 'black';
  color: string;
}) {
  const f = squareToPixels(from, squareSize, orientation);
  const t = squareToPixels(to, squareSize, orientation);
  const fcx = f.x + squareSize / 2;
  const fcy = f.y + squareSize / 2;
  const tcx = t.x + squareSize / 2;
  const tcy = t.y + squareSize / 2;
  const dx = tcx - fcx;
  const dy = tcy - fcy;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  const thickness = Math.max(4, squareSize * 0.12);
  const headLength = thickness * 2.2;
  const headWidth = thickness * 2;
  // Body stops short so it doesn't poke through the arrowhead.
  const bodyLength = Math.max(0, length - headLength * 0.6);

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
    >
      <View
        style={{
          position: 'absolute',
          left: (fcx + tcx) / 2 - bodyLength / 2,
          top: (fcy + tcy) / 2 - thickness / 2,
          width: bodyLength,
          height: thickness,
          backgroundColor: color,
          borderRadius: thickness / 2,
          transform: [{ rotate: `${angleDeg}deg` }],
          opacity: 0.85,
        }}
      />
      {/* "X" badge — another piece may also legally reach this square, so the
          X sits on the arrow itself rather than the to-square. */}
      <View
        style={{
          position: 'absolute',
          left: (fcx + tcx) / 2 - thickness * 1.1,
          top: (fcy + tcy) / 2 - thickness * 1.1,
          width: thickness * 2.2,
          height: thickness * 2.2,
          borderRadius: thickness * 1.1,
          backgroundColor: color,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1.5,
          borderColor: '#ffffff',
        }}
      >
        <Text
          style={{
            color: '#ffffff',
            fontSize: thickness * 1.4,
            fontWeight: '900',
            lineHeight: thickness * 1.6,
          }}
        >
          ✕
        </Text>
      </View>
      {/* Head — container center offset back so the triangle's tip lands at
          (tcx, tcy). */}
      <View
        style={{
          position: 'absolute',
          left: tcx - (headLength / 2) * Math.cos((angleDeg * Math.PI) / 180) - headLength / 2,
          top: tcy - (headLength / 2) * Math.sin((angleDeg * Math.PI) / 180) - headWidth / 2,
          width: headLength,
          height: headWidth,
          transform: [{ rotate: `${angleDeg}deg` }],
          alignItems: 'flex-end',
          justifyContent: 'center',
          opacity: 0.9,
        }}
      >
        <View
          style={{
            width: 0,
            height: 0,
            borderTopWidth: headWidth / 2,
            borderBottomWidth: headWidth / 2,
            borderLeftWidth: headLength,
            borderTopColor: 'transparent',
            borderBottomColor: 'transparent',
            borderLeftColor: color,
          }}
        />
      </View>
    </View>
  );
});
