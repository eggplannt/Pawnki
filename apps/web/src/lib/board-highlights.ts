import type React from 'react';
import { Chess, type Square } from 'chess.js';

export function legalTargetStyles(
  fen: string,
  fromSquare: string,
  accentColor: string,
): Record<string, React.CSSProperties> {
  const styles: Record<string, React.CSSProperties> = {};
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return styles;
  }
  let moves;
  try {
    moves = chess.moves({ square: fromSquare as Square, verbose: true });
  } catch {
    return styles;
  }
  for (const m of moves) {
    const isCapture = !!chess.get(m.to as Square) || m.flags.includes('e');
    styles[m.to] = isCapture
      ? { background: `radial-gradient(circle, transparent 55%, ${accentColor} 55%, ${accentColor} 68%, transparent 68%)` }
      : { background: `radial-gradient(circle, ${accentColor} 25%, transparent 25%)`, opacity: 0.8 };
  }
  return styles;
}
