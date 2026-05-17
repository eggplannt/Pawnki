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

const ANIMATION_MS = 200;
const DRAG_SCALE = 1.15;

// ── FEN helpers ──────────────────────────────────────────────────────────

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

// row 0 = rank 8, row 7 = rank 1 (board array is white-perspective)
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
 * Reconcile `oldPieces` against a new FEN: each existing piece tries to keep
 * its identity by claiming the nearest unoccupied new square of the same type.
 * Unmatched old pieces are dropped (capture); unmatched new squares get fresh
 * piece instances (promotion / pasted position).
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
  const matched = new Map<string, string>(); // pieceId -> newSquare

  // Pass 1: pieces that didn't move keep their square.
  for (const oldP of oldPieces) {
    const list = newByType.get(oldP.type);
    if (list && list.includes(oldP.square) && !used.has(oldP.square)) {
      matched.set(oldP.id, oldP.square);
      used.add(oldP.square);
    }
  }

  // Pass 2: remaining old pieces take the closest unused new square.
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
    if (!sq) continue; // captured
    // Reuse the same object reference when nothing changed so memo'd children
    // can skip re-rendering (and their useEffects don't refire).
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
  onDrop: (from: string, to: string | null) => void;
  /** Map of legal target squares for the piece currently being dragged.
   *  Read from the worklet on drop to decide whether to snap (legal move,
   *  parent will reposition via FEN change) or animate back to source. */
  legalTargetsSV: { value: Record<string, boolean> };
  /** 1 while indicators should be visible, 0 to hide them instantly on drop
   *  (before React unmounts them via setSelected(null)). */
  indicatorsVisibleSV: { value: number };
}

export interface AnimatedPieceHandle {
  /** Snap the piece directly (no animation) to the given square's pixels, or
   *  to its current logical square if omitted. Called when the parent rejects
   *  a chess-legal drop so the optimistic snap in the gesture's onEnd is
   *  reversed without an animated back-glide. */
  snapBack: (square?: string) => void;
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
}, ref) {
  const initial = useMemo(
    () => squareToPixels(piece.square, squareSize, orientation),
    // only the initial mount value — subsequent updates go through useEffect
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const baseX = useSharedValue(initial.x);
  const baseY = useSharedValue(initial.y);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  // Offset from the piece center to the touch point at gesture start. Applied
  // so the piece re-centers under the finger instead of staying anchored to
  // wherever the user happened to touch on the piece.
  const fingerOffsetX = useSharedValue(0);
  const fingerOffsetY = useSharedValue(0);
  const dragging = useSharedValue(0); // 0 or 1; drives scale + zIndex

  // Animate to the new square pixels whenever the piece's logical square,
  // the board size, or the orientation changes.
  useEffect(() => {
    const t = squareToPixels(piece.square, squareSize, orientation);
    baseX.value = withTiming(t.x, { duration: ANIMATION_MS });
    baseY.value = withTiming(t.y, { duration: ANIMATION_MS });
  }, [piece.square, squareSize, orientation, baseX, baseY]);

  // All worklet-captured values are bundled into stable primitives so the
  // memoized gesture only needs to recompute when they actually change.
  const isWhiteOrient = orientation === 'white';
  const pieceSquare = piece.square;

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
        cancelAnimation(baseX);
        cancelAnimation(baseY);
        // Capture finger position within the piece view so we can re-center
        // the piece on the finger. The piece's view top-left is at (baseX,
        // baseY) when the gesture starts (dragX/Y = 0), and the view is
        // squareSize on each side, so e.x/y is the finger offset within it.
        fingerOffsetX.value = e.x - squareSize / 2;
        fingerOffsetY.value = e.y - squareSize / 2;
        dragX.value = fingerOffsetX.value;
        dragY.value = fingerOffsetY.value;
        dragging.value = withTiming(1, { duration: 80 });
        runOnJS(onDragStart)(pieceSquare);
      })
      .onUpdate((e) => {
        'worklet';
        dragX.value = e.translationX + fingerOffsetX.value;
        dragY.value = e.translationY + fingerOffsetY.value;
      })
      .onEnd((e) => {
        'worklet';
        // Drop target is where the finger is — i.e. the piece's visual center,
        // which now equals the finger position because of fingerOffset above.
        const releaseX = baseX.value + e.translationX + fingerOffsetX.value + squareSize / 2;
        const releaseY = baseY.value + e.translationY + fingerOffsetY.value + squareSize / 2;
        const vCol = Math.floor(releaseX / squareSize);
        const vRow = Math.floor(releaseY / squareSize);
        let target: string | null = null;
        if (vCol >= 0 && vCol < 8 && vRow >= 0 && vRow < 8) {
          const col = isWhiteOrient ? vCol : 7 - vCol;
          const row = isWhiteOrient ? vRow : 7 - vRow;
          target = `${String.fromCharCode(97 + col)}${8 - row}`;
        }
        // Snap instantly to final position — no animation on drop, for snappy
        // feel. Legal target → snap to that square's pixels; otherwise → snap
        // back to source by zeroing drag offsets (baseX/Y still hold source).
        if (target && target !== pieceSquare && legalTargetsSV.value[target]) {
          baseX.value = vCol * squareSize;
          baseY.value = vRow * squareSize;
        }
        dragX.value = 0;
        dragY.value = 0;
        // Hide indicators immediately; React will unmount them shortly via
        // setSelected(null), but that's a frame or two behind.
        indicatorsVisibleSV.value = 0;
        dragging.value = withTiming(0, { duration: 80 });
        runOnJS(onDrop)(pieceSquare, target);
      })
      .onFinalize(() => {
        'worklet';
        dragging.value = withTiming(0, { duration: 80 });
      });

    return Gesture.Race(tap, pan);
  }, [pieceSquare, squareSize, isWhiteOrient, onTap, onDragStart, onDrop, baseX, baseY, dragX, dragY, fingerOffsetX, fingerOffsetY, dragging, legalTargetsSV, indicatorsVisibleSV]);

  const animStyle = useAnimatedStyle(() => {
    const scale = 1 + dragging.value * (DRAG_SCALE - 1);
    return {
      transform: [
        { translateX: baseX.value + dragX.value },
        { translateY: baseY.value + dragY.value },
        { scale },
      ],
      zIndex: dragging.value > 0 ? 100 : 1,
    };
  });

  useImperativeHandle(ref, () => ({
    snapBack: (square?: string) => {
      const t = squareToPixels(square ?? piece.square, squareSize, orientation);
      baseX.value = t.x;
      baseY.value = t.y;
      dragX.value = 0;
      dragY.value = 0;
    },
  }), [piece.square, squareSize, orientation, baseX, baseY, dragX, dragY]);

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
  isCapture, squareSize, color, visibleSV,
}: {
  isCapture: boolean;
  squareSize: number;
  color: string;
  visibleSV: { value: number };
}) {
  const style = useAnimatedStyle(() => ({ opacity: visibleSV.value }));
  const shape: ViewStyle = isCapture
    ? {
        width: '92%', height: '92%', borderRadius: 999,
        borderWidth: Math.max(2, squareSize * 0.08), borderColor: color,
      }
    : {
        width: '30%', height: '30%', borderRadius: 999, backgroundColor: color,
      };
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute' }, shape, style]}
    />
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
  /** Tap-to-move or drag-to-move. May return a boolean to synchronously signal
   *  whether the parent accepted the move; `false` lets the board skip its
   *  optimistic-capture hide so a rejected move doesn't flicker the captured
   *  piece. Returning `void` keeps the existing optimistic behavior (with rAF
   *  detection of FEN-based rejection). */
  onMove?: (move: ChessboardMove) => unknown;
  disabled?: boolean;
  squareStyles?: Record<string, StyleProp<ViewStyle>>;
  darkSquareColor?: string;
  lightSquareColor?: string;
  /** If provided, pieces position immediately on first render instead of
   *  waiting for onLayout. Should match the rendered board width. */
  size?: number;
  /** Overlay arrows drawn from→to. Used to hint at already-practiced lines. */
  arrows?: Array<{ from: string; to: string; color?: string }>;
}

export const Chessboard = memo(function Chessboard({
  fen,
  orientation = 'white',
  onMove,
  disabled = false,
  darkSquareColor,
  squareStyles,
  lightSquareColor,
  size,
  arrows,
}: ChessboardProps) {
  const { colors: colorTheme } = useColorTheme();
  const resolvedDark = darkSquareColor ?? colorTheme.board.dark;
  const resolvedLight = lightSquareColor ?? colorTheme.board.light;
  const [pieces, setPieces] = useState<PieceInstance[]>(() => initialPieces(fen));
  const piecesRef = useRef(pieces);
  piecesRef.current = pieces;
  const lastFenRef = useRef(fen);
  const pieceHandlesRef = useRef<Map<string, AnimatedPieceHandle>>(new Map());
  // Captured-piece id hidden optimistically on a legal capture drop so the
  // captured piece doesn't flash over the user's piece while we wait for the
  // parent to advance the FEN. Restored on parent rejection; cleared for real
  // on FEN-driven reconciliation.
  const [hiddenPieceId, setHiddenPieceId] = useState<string | null>(null);

  useEffect(() => {
    if (lastFenRef.current === fen) return;
    setPieces((prev) => reconcilePieces(prev, fen));
    lastFenRef.current = fen;
    setHiddenPieceId(null);
  }, [fen]);

  const [measuredSize, setMeasuredSize] = useState(0);
  const boardSize = size ?? measuredSize;
  const squareSize = boardSize / 8;

  const interactive = !disabled && !!onMove;
  const sideToMove = fen.split(' ')[1] === 'w' ? 'w' : 'b';

  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { setSelected(null); }, [fen]);

  // Map of legal target square → isCapture. Capture targets render as a ring,
  // empty targets as a dot, matching the web indicator style.
  const legalTargets = useMemo(() => {
    if (!selected) return new Map<string, boolean>();
    try {
      const chess = new Chess(fen);
      const moves = chess.moves({ square: selected as any, verbose: true });
      const out = new Map<string, boolean>();
      for (const m of moves as any[]) {
        out.set(m.to as string, !!chess.get(m.to as any) || (m.flags as string).includes('e'));
      }
      return out;
    } catch {
      return new Map<string, boolean>();
    }
  }, [selected, fen]);

  // Worklet-readable mirror of legalTargets. The drag onEnd worklet uses it to
  // decide whether to snap the piece to the release point (legal drop, parent
  // will reposition via FEN change) or animate it back to source (illegal).
  const legalTargetsSV = useSharedValue<Record<string, boolean>>({});
  const indicatorsVisibleSV = useSharedValue(1);
  useEffect(() => {
    const map: Record<string, boolean> = {};
    for (const sq of legalTargets.keys()) map[sq] = true;
    legalTargetsSV.value = map;
    // Re-show indicators whenever the selected piece changes (or selection
    // clears and a new drag selects another piece). The drop worklet hides
    // them; this restores visibility for the next selection.
    indicatorsVisibleSV.value = 1;
  }, [legalTargets, legalTargetsSV, indicatorsVisibleSV]);

  // Keep a ref to the latest interaction context so the callbacks we hand to
  // each AnimatedPiece can stay referentially stable. Otherwise every state
  // change in this component would invalidate memo on all 32 pieces and force
  // their native GestureDetectors to re-attach — which is the dominant cost.
  const ctxRef = useRef({ fen, selected, legalTargets, sideToMove, interactive, onMove });
  ctxRef.current = { fen, selected, legalTargets, sideToMove, interactive, onMove };

  // Returns { legal: boolean, acceptedHint: boolean | undefined } — acceptedHint
  // is whatever the parent's onMove returned (undefined if it doesn't signal).
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
      // ignore
    }
    return { legal: false, acceptedHint: undefined };
  }, []);

  // Tap on a piece (via gesture on the AnimatedPiece overlay).
  const handlePieceTap = useCallback((sq: string) => {
    const { interactive, selected, legalTargets, fen, sideToMove } = ctxRef.current;
    if (!interactive) return;
    if (selected && legalTargets.has(sq)) {
      if (tryMove(selected, sq).legal) setSelected(null);
      return;
    }
    const board = parseFen(fen);
    const { row, col } = squareToRowCol(sq);
    const piece = board[row]?.[col];
    if (piece && (piece === piece.toUpperCase() ? 'w' : 'b') === sideToMove) {
      setSelected(sq === selected ? null : sq);
    } else {
      setSelected(null);
    }
  }, [tryMove]);

  // Tap on an empty square (or a non-selectable square) via Pressable.
  const handleSquareTap = useCallback((sq: string) => {
    const { interactive, selected, legalTargets } = ctxRef.current;
    if (!interactive) return;
    if (selected && legalTargets.has(sq)) {
      if (tryMove(selected, sq).legal) setSelected(null);
      return;
    }
    if (selected) setSelected(null);
  }, [tryMove]);

  // Drag start: select the piece so legal-target dots appear while dragging.
  const handlePieceDragStart = useCallback((sq: string) => {
    if (!ctxRef.current.interactive) return;
    setSelected(sq);
  }, []);

  // Drag release: try the move; if not legal, the piece animates back to source.
  // For drops where chess.js says the move is legal, the gesture's onEnd has
  // already optimistically snapped the piece to the release point — but the
  // parent may still reject the move (e.g. wrong line in Practice mode), in
  // which case the FEN won't change. If that happens, animate the piece back
  // to its source square so it doesn't sit stuck on top of the captured piece.
  const handlePieceDrop = useCallback((from: string, to: string | null) => {
    if (!ctxRef.current.interactive) return;
    const fenBefore = ctxRef.current.fen;
    const draggedId = piecesRef.current.find((p) => p.square === from)?.id ?? null;
    const isLegalDrop = !!(to && to !== from && ctxRef.current.legalTargets.has(to));

    // Call the parent first so we can use its return value to decide whether
    // to apply optimistic UI. Parents that signal rejection synchronously let
    // us skip the optimistic hide/move entirely — no flicker on wrong moves.
    let acceptedHint: boolean | undefined = undefined;
    if (to && to !== from) {
      acceptedHint = tryMove(from, to).acceptedHint;
    }
    const definitelyRejected = acceptedHint === false;

    let optimisticallyHidden: string | null = null;
    let optimisticallyMoved = false;
    if (isLegalDrop && !definitelyRejected) {
      // Hide any captured opponent piece on the target square so it doesn't
      // briefly cover the user's piece while the parent advances state.
      const cap = piecesRef.current.find((p) => p.square === to && p.id !== draggedId);
      if (cap) {
        optimisticallyHidden = cap.id;
        setHiddenPieceId(cap.id);
      }
      // Optimistically update the dragged piece's logical square to the drop
      // target so reconcilePieces lines up correctly when the parent's next
      // FEN backtracks. (Without this, Pass 1 of reconcile matches the piece
      // to its still-at-source logical square, no useEffect fires, and baseX/Y
      // stays stuck at the capture target.)
      if (draggedId) {
        optimisticallyMoved = true;
        setPieces((prev) => prev.map((p) => p.id === draggedId ? { ...p, square: to } : p));
      }
    }

    setSelected(null);

    if (definitelyRejected && draggedId && isLegalDrop) {
      // Snap the piece straight back to source. No optimistic state to undo.
      pieceHandlesRef.current.get(draggedId)?.snapBack(from);
    } else if (acceptedHint === undefined && draggedId && to && to !== from) {
      // Parent didn't signal — fall back to rAF detection of FEN-based rejection.
      requestAnimationFrame(() => {
        if (lastFenRef.current === fenBefore) {
          pieceHandlesRef.current.get(draggedId)?.snapBack(from);
          if (optimisticallyHidden) setHiddenPieceId(null);
          if (optimisticallyMoved) {
            setPieces((prev) => prev.map((p) => p.id === draggedId ? { ...p, square: from } : p));
          }
        }
      });
    }
  }, [tryMove]);

  function onBoardLayout(e: LayoutChangeEvent) {
    if (size !== undefined) return;
    const w = e.nativeEvent.layout.width;
    if (w !== measuredSize) setMeasuredSize(w);
  }

  const rows = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const cols = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  return (
    <View
      onLayout={onBoardLayout}
      style={{ aspectRatio: 1, borderRadius: 8, overflow: 'hidden', position: 'relative' }}
    >
      {/* Squares: visual background + tap-to-move/deselect targets */}
      {rows.map((row) => (
        <View key={row} style={{ flex: 1, flexDirection: 'row' }}>
          {cols.map((col) => {
            const isLight = (row + col) % 2 === 0;
            const sq = squareId(row, col);
            const extraStyle = squareStyles ? squareStyles[sq] : null
            const isSelected = selected === sq;
            const captureHere = legalTargets.get(sq);
            const isLegalTarget = captureHere !== undefined;
            const isCaptureTarget = captureHere === true;
            const baseBg = isLight ? resolvedLight : resolvedDark;
            return (
              <Pressable
                key={col}
                onPress={() => handleSquareTap(sq)}
                disabled={!interactive}
                style={[{
                  flex: 1,
                  backgroundColor: isSelected ? colorTheme.accent.dim : baseBg,
                  alignItems: 'center',
                  justifyContent: 'center',
                }, extraStyle]}
              >
                {isLegalTarget && (
                  <LegalTargetIndicator
                    isCapture={isCaptureTarget}
                    squareSize={squareSize}
                    color={colorTheme.accent.default + 'AA'}
                    visibleSV={indicatorsVisibleSV}
                  />
                )}
              </Pressable>
            );
          })}
        </View>
      ))}

      {/* Animated piece overlays */}
      {squareSize > 0 && pieces.filter((p) => p.id !== hiddenPieceId).map((p) => (
        <AnimatedPiece
          key={p.id}
          ref={(h) => {
            if (h) pieceHandlesRef.current.set(p.id, h);
            else pieceHandlesRef.current.delete(p.id);
          }}
          piece={p}
          squareSize={squareSize}
          orientation={orientation}
          onTap={handlePieceTap}
          onDragStart={handlePieceDragStart}
          onDrop={handlePieceDrop}
          legalTargetsSV={legalTargetsSV}
          indicatorsVisibleSV={indicatorsVisibleSV}
        />
      ))}

      {/* Arrow overlays (drawn on top of pieces) */}
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
  // Body stops just before the arrowhead so they don't overlap awkwardly.
  const bodyLength = Math.max(0, length - headLength * 0.6);

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
    >
      {/* Shaft */}
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
      {/* "X" badge at the midpoint of the arrow — another piece may legally
          move to the to-square, so the X must sit on the arrow itself. */}
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
      {/* Head — triangle pointing along the arrow direction. Container center
          is offset back by headLength/2 so the tip lands at (tcx, tcy). */}
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
