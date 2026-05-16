import { memo, useMemo, useState } from 'react';
import { View, Image, Pressable, type ImageSourcePropType } from 'react-native';
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
  const board = useMemo(() => parseFen(fen), [fen]);
  const sideToMove = fen.split(' ')[1] === 'w' ? 'w' : 'b';
  const interactive = !disabled && !!onMove;

  const [selected, setSelected] = useState<string | null>(null);
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

  return (
    <View style={{ aspectRatio: 1, borderRadius: 8, overflow: 'hidden' }}>
      {rows.map((row) => (
        <View key={row} style={{ flex: 1, flexDirection: 'row' }}>
          {cols.map((col) => {
            const isLight = (row + col) % 2 === 0;
            const piece = board[row]?.[col] ?? null;
            const sq = squareId(row, col);
            const isSelected = selected === sq;
            const isLegalTarget = legalTargets.has(sq);
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
                {piece && PIECES[piece] && (
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
    </View>
  );
});
