import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Image,
  Pressable,
  Animated,
  type ImageSourcePropType,
  type LayoutChangeEvent,
} from 'react-native';
import { Chess } from 'chess.js';
import { colorTheme } from '@/hooks/useColorTheme';

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

const ANIMATION_MS = 180;

function parseFen(fen: string): (string | null)[][] {
  const rows = fen.split(' ')[0].split('/');
  return rows.map((row) => {
    const squares: (string | null)[] = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < parseInt(ch); i++) squares.push(null);
      } else {
        squares.push(ch);
      }
    }
    return squares;
  });
}

function squareId(row: number, col: number): string {
  // row 0 = rank 8, row 7 = rank 1 (board array is white-perspective)
  return `${String.fromCharCode('a'.charCodeAt(0) + col)}${8 - row}`;
}

interface PieceMove {
  from: { row: number; col: number };
  to: { row: number; col: number };
  piece: string;
}

/**
 * Find piece movements between two FENs. Matches each arrival to the
 * closest departure of the same piece type. Handles captures, castling,
 * and most multi-move jumps; promotions show as a vanish + appear.
 */
function diffPositions(oldFen: string, newFen: string): PieceMove[] {
  const oldBoard = parseFen(oldFen);
  const newBoard = parseFen(newFen);

  const departedByPiece = new Map<string, Array<{ row: number; col: number }>>();
  const arrived: Array<{ piece: string; row: number; col: number }> = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const oldP = oldBoard[r]?.[c] ?? null;
      const newP = newBoard[r]?.[c] ?? null;
      if (oldP === newP) continue;
      if (oldP) {
        const list = departedByPiece.get(oldP) ?? [];
        list.push({ row: r, col: c });
        departedByPiece.set(oldP, list);
      }
      if (newP) {
        arrived.push({ piece: newP, row: r, col: c });
      }
    }
  }

  const moves: PieceMove[] = [];
  for (const t of arrived) {
    const list = departedByPiece.get(t.piece);
    if (!list || list.length === 0) continue;

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const dist = Math.abs(s.row - t.row) + Math.abs(s.col - t.col);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    moves.push({ from: list[bestIdx], to: { row: t.row, col: t.col }, piece: t.piece });
    list.splice(bestIdx, 1);
  }

  return moves;
}

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
  /** Tap-to-move: tap a piece to select, tap a legal target to move. */
  onMove?: (move: ChessboardMove) => void;
  disabled?: boolean;
  darkSquareColor?: string;
  lightSquareColor?: string;
}

export const Chessboard = memo(function Chessboard({
  fen,
  orientation = 'white',
  onMove,
  disabled = false,
  darkSquareColor = colorTheme.gold.dim,
  lightSquareColor = '#dcc8a0',
}: ChessboardProps) {
  // What's currently rendered on the board (may lag `fen` while animating).
  const [displayedFen, setDisplayedFen] = useState(fen);
  const [animations, setAnimations] = useState<PieceMove[]>([]);
  const [boardSize, setBoardSize] = useState(0);
  const squareSize = boardSize / 8;

  // A single shared progress value (0→1) drives every in-flight piece via
  // interpolation. Using one persistent Animated.Value (vs creating a new one
  // per move) keeps the native binding stable across renders and avoids the
  // "start() before view is mounted" race that causes the no-animation flicker.
  const progress = useRef(new Animated.Value(0)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const fenRef = useRef(fen);
  fenRef.current = fen;

  // Detect fen change → create overlay pieces.
  useEffect(() => {
    if (fen === displayedFen) return;

    // No layout yet — can't compute pixel offsets, so just snap.
    if (squareSize === 0) {
      setDisplayedFen(fen);
      return;
    }

    // If a previous animation is still running, snap to the new fen rather
    // than chaining — chaining from a mid-flight position would require
    // re-reading transforms, which adds complexity for little benefit here.
    if (animationRef.current) {
      animationRef.current.stop();
      animationRef.current = null;
      progress.setValue(0);
      setAnimations([]);
      setDisplayedFen(fen);
      return;
    }

    const moves = diffPositions(displayedFen, fen);
    if (moves.length === 0) {
      setDisplayedFen(fen);
      return;
    }

    progress.setValue(0);
    setAnimations(moves);
  }, [fen, displayedFen, squareSize, progress]);

  // Once the overlay Animated.Views are committed (and their interpolations
  // are bound to the native driver), drive the shared progress value. The
  // requestAnimationFrame defers start() by one frame so the native binding
  // is guaranteed to be in place — without it useNativeDriver can snap the
  // value to its end state on the very first frame.
  useEffect(() => {
    if (animations.length === 0) return;
    if (animationRef.current) return;

    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      const anim = Animated.timing(progress, {
        toValue: 1,
        duration: ANIMATION_MS,
        useNativeDriver: true,
      });
      animationRef.current = anim;

      anim.start(({ finished }) => {
        if (finished && animationRef.current === anim) {
          setDisplayedFen(fenRef.current);
          setAnimations([]);
          animationRef.current = null;
        }
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [animations, progress]);

  const displayBoard = useMemo(() => parseFen(displayedFen), [displayedFen]);
  const sideToMove = fen.split(' ')[1] === 'w' ? 'w' : 'b';
  const interactive = !disabled && !!onMove;

  const [selected, setSelected] = useState<string | null>(null);

  // Clear selection whenever the position changes (e.g. nav button, move played)
  useEffect(() => {
    setSelected(null);
  }, [fen]);

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

  const rows = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const cols = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  const hiddenSources = useMemo(
    () => new Set(animations.map((a) => `${a.from.row},${a.from.col}`)),
    [animations],
  );

  const handleSquarePress = (sq: string, piece: string | null) => {
    if (!interactive) return;
    if (selected && legalTargets.has(sq)) {
      try {
        const chess = new Chess(fen);
        const result = chess.move({ from: selected, to: sq, promotion: 'q' });
        if (result) {
          onMove?.({
            san: result.san,
            uci: result.from + result.to + (result.promotion ?? ''),
            fen: chess.fen(),
            from: result.from,
            to: result.to,
          });
        }
      } catch {
        // ignore — chess.js throws on invalid move
      }
      setSelected(null);
      return;
    }
    // Tap on own piece: select; anywhere else: clear
    if (piece && (piece === piece.toUpperCase() ? 'w' : 'b') === sideToMove) {
      setSelected(sq === selected ? null : sq);
    } else {
      setSelected(null);
    }
  };

  function onBoardLayout(e: LayoutChangeEvent) {
    const w = e.nativeEvent.layout.width;
    if (w !== boardSize) setBoardSize(w);
  }

  return (
    <View
      onLayout={onBoardLayout}
      style={{ aspectRatio: 1, borderRadius: 8, overflow: 'hidden', position: 'relative' }}
    >
      {rows.map((row) => (
        <View key={row} style={{ flex: 1, flexDirection: 'row' }}>
          {cols.map((col) => {
            const isLight = (row + col) % 2 === 0;
            const piece = displayBoard[row]?.[col] ?? null;
            const sq = squareId(row, col);
            const isSelected = selected === sq;
            const isLegalTarget = legalTargets.has(sq);
            const isHidden = hiddenSources.has(`${row},${col}`);
            const baseBg = isLight ? lightSquareColor : darkSquareColor;
            return (
              <Pressable
                key={col}
                onPress={() => handleSquarePress(sq, piece)}
                disabled={!interactive}
                style={{
                  flex: 1,
                  backgroundColor: isSelected ? colorTheme.accent.dim : baseBg,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {piece && PIECES[piece] && !isHidden && (
                  <Image
                    source={PIECES[piece]}
                    style={{ width: '85%', height: '85%' }}
                    resizeMode="contain"
                  />
                )}
                {isLegalTarget && (
                  <View
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      width: piece ? '90%' : '30%',
                      height: piece ? '90%' : '30%',
                      borderRadius: 999,
                      borderWidth: piece ? 3 : 0,
                      borderColor: piece ? colorTheme.accent.default : 'transparent',
                      backgroundColor: piece ? 'transparent' : colorTheme.accent.default + 'AA',
                    }}
                  />
                )}
              </Pressable>
            );
          })}
        </View>
      ))}

      {/* Animated overlay pieces (sliding from source square to target square) */}
      {squareSize > 0 && animations.map((m, i) => {
        const fromVCol = orientation === 'white' ? m.from.col : 7 - m.from.col;
        const fromVRow = orientation === 'white' ? m.from.row : 7 - m.from.row;
        const toVCol = orientation === 'white' ? m.to.col : 7 - m.to.col;
        const toVRow = orientation === 'white' ? m.to.row : 7 - m.to.row;
        const dx = (toVCol - fromVCol) * squareSize;
        const dy = (toVRow - fromVRow) * squareSize;

        return (
          <Animated.View
            key={`${m.piece}-${m.from.row}-${m.from.col}-${m.to.row}-${m.to.col}-${i}`}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: fromVCol * squareSize,
              top: fromVRow * squareSize,
              width: squareSize,
              height: squareSize,
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
              transform: [
                { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
                { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, dy] }) },
              ],
            }}
          >
            <Image
              source={PIECES[m.piece]}
              style={{ width: '85%', height: '85%' }}
              resizeMode="contain"
            />
          </Animated.View>
        );
      })}
    </View>
  );
});
