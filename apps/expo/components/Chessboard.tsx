import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
}

const AnimatedPiece = memo(function AnimatedPiece({
  piece,
  squareSize,
  orientation,
  onTap,
  onDragStart,
  onDrop,
}: AnimatedPieceProps) {
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
      .onStart(() => {
        'worklet';
        cancelAnimation(baseX);
        cancelAnimation(baseY);
        dragging.value = withTiming(1, { duration: 80 });
        runOnJS(onDragStart)(pieceSquare);
      })
      .onUpdate((e) => {
        'worklet';
        dragX.value = e.translationX;
        dragY.value = e.translationY;
      })
      .onEnd((e) => {
        'worklet';
        const releaseX = baseX.value + e.translationX + squareSize / 2;
        const releaseY = baseY.value + e.translationY + squareSize / 2;
        const vCol = Math.floor(releaseX / squareSize);
        const vRow = Math.floor(releaseY / squareSize);
        let target: string | null = null;
        if (vCol >= 0 && vCol < 8 && vRow >= 0 && vRow < 8) {
          const col = isWhiteOrient ? vCol : 7 - vCol;
          const row = isWhiteOrient ? vRow : 7 - vRow;
          target = `${String.fromCharCode(97 + col)}${8 - row}`;
        }
        dragX.value = withTiming(0, { duration: ANIMATION_MS });
        dragY.value = withTiming(0, { duration: ANIMATION_MS });
        dragging.value = withTiming(0, { duration: 80 });
        runOnJS(onDrop)(pieceSquare, target);
      })
      .onFinalize(() => {
        'worklet';
        dragging.value = withTiming(0, { duration: 80 });
      });

    return Gesture.Race(tap, pan);
  }, [pieceSquare, squareSize, isWhiteOrient, onTap, onDragStart, onDrop, baseX, baseY, dragX, dragY, dragging]);

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
  /** Tap-to-move or drag-to-move. */
  onMove?: (move: ChessboardMove) => void;
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
  const lastFenRef = useRef(fen);

  useEffect(() => {
    if (lastFenRef.current === fen) return;
    setPieces((prev) => reconcilePieces(prev, fen));
    lastFenRef.current = fen;
  }, [fen]);

  const [measuredSize, setMeasuredSize] = useState(0);
  const boardSize = size ?? measuredSize;
  const squareSize = boardSize / 8;

  const interactive = !disabled && !!onMove;
  const sideToMove = fen.split(' ')[1] === 'w' ? 'w' : 'b';

  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { setSelected(null); }, [fen]);

  const legalTargets = useMemo(() => {
    if (!selected) return new Set<string>();
    try {
      const chess = new Chess(fen);
      const moves = chess.moves({ square: selected as any, verbose: true });
      return new Set(moves.map((m: any) => m.to as string));
    } catch {
      return new Set<string>();
    }
  }, [selected, fen]);

  // Keep a ref to the latest interaction context so the callbacks we hand to
  // each AnimatedPiece can stay referentially stable. Otherwise every state
  // change in this component would invalidate memo on all 32 pieces and force
  // their native GestureDetectors to re-attach — which is the dominant cost.
  const ctxRef = useRef({ fen, selected, legalTargets, sideToMove, interactive, onMove });
  ctxRef.current = { fen, selected, legalTargets, sideToMove, interactive, onMove };

  const tryMove = useCallback((from: string, to: string): boolean => {
    const ctx = ctxRef.current;
    if (!ctx.interactive) return false;
    try {
      const chess = new Chess(ctx.fen);
      const result = chess.move({ from, to, promotion: 'q' });
      if (result) {
        ctx.onMove?.({
          san: result.san,
          uci: result.from + result.to + (result.promotion ?? ''),
          fen: chess.fen(),
          from: result.from,
          to: result.to,
        });
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }, []);

  // Tap on a piece (via gesture on the AnimatedPiece overlay).
  const handlePieceTap = useCallback((sq: string) => {
    const { interactive, selected, legalTargets, fen, sideToMove } = ctxRef.current;
    if (!interactive) return;
    if (selected && legalTargets.has(sq)) {
      if (tryMove(selected, sq)) setSelected(null);
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
      if (tryMove(selected, sq)) setSelected(null);
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
  const handlePieceDrop = useCallback((from: string, to: string | null) => {
    if (!ctxRef.current.interactive) return;
    if (to && to !== from) tryMove(from, to);
    // Clear regardless: successful move's fen change would clear anyway; on
    // illegal drop we don't want the hover-dots lingering.
    setSelected(null);
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
            const isLegalTarget = legalTargets.has(sq);
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
                  <View
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      width: '30%',
                      height: '30%',
                      borderRadius: 999,
                      backgroundColor: colorTheme.accent.default + 'AA',
                    }}
                  />
                )}
              </Pressable>
            );
          })}
        </View>
      ))}

      {/* Animated piece overlays */}
      {squareSize > 0 && pieces.map((p) => (
        <AnimatedPiece
          key={p.id}
          piece={p}
          squareSize={squareSize}
          orientation={orientation}
          onTap={handlePieceTap}
          onDragStart={handlePieceDragStart}
          onDrop={handlePieceDrop}
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
