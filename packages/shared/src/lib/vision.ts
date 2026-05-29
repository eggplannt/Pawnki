import { Chess, type Square, type Color, type PieceSymbol } from 'chess.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;

export const ALL_SQUARES: Square[] = FILES.flatMap((f) =>
  RANKS.map((r) => `${f}${r}` as Square),
);

const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

export type VisionQuestionKind = 'see';

export type VisionQuestion = {
  kind: VisionQuestionKind;
  /** Squares to highlight as "focus" while answering (e.g., the piece being asked about). */
  focusSquares: Square[];
  /** Correct set of squares the player should tap. */
  correctSquares: Square[];
  /** Player-facing prompt. */
  prompt: string;
};

/** Squares attacked or defended by the piece sitting on `pieceSquare`. */
export function squaresControlledBy(fen: string, pieceSquare: Square): Square[] {
  const chess = new Chess(fen);
  const piece = chess.get(pieceSquare);
  if (!piece) return [];
  const out: Square[] = [];
  for (const sq of ALL_SQUARES) {
    if (sq === pieceSquare) continue;
    const attackers = chess.attackers(sq, piece.color);
    if (attackers && attackers.includes(pieceSquare)) out.push(sq);
  }
  return out;
}


/**
 * Generate "which pieces can see X" questions for the position. The player must
 * tap every piece (regardless of color) whose move set includes the target square.
 * Returns at most `count` questions, prioritizing contested squares with many
 * attackers/defenders. Focus squares listed in `excludeFocusSquares` are skipped
 * — used by the trainer to avoid repeating a target within the recent-move window.
 */
export function generateStaticQuestions(
  fen: string,
  count = 3,
  excludeFocusSquares: ReadonlySet<Square> = new Set(),
): VisionQuestion[] {
  const chess = new Chess(fen);
  const candidates: { q: VisionQuestion; score: number }[] = [];

  for (const sq of ALL_SQUARES) {
    if (excludeFocusSquares.has(sq)) continue;
    // Union of attackers from both colors — "pieces that can see this square."
    const whiteAtks = chess.attackers(sq, 'w') ?? [];
    const blackAtks = chess.attackers(sq, 'b') ?? [];
    const seers: Square[] = [...whiteAtks, ...blackAtks];
    if (seers.length < 2) continue; // skip trivial 0/1-attacker squares
    const target = chess.get(sq);
    // Prefer hot squares: occupied targets (real pressure) and high seer counts.
    const occupancyBoost = target ? 1.5 : 1.0;
    const score = occupancyBoost * seers.length + Math.random() * 0.5;
    candidates.push({
      score,
      q: {
        kind: 'see',
        focusSquares: [sq],
        correctSquares: seers,
        prompt: `Which pieces can see ${sq}?`,
      },
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  // Take the top `count` with distinct focus squares.
  const picked: VisionQuestion[] = [];
  const usedFocus = new Set<string>();
  for (const c of candidates) {
    if (picked.length >= count) break;
    const focusKey = c.q.focusSquares.join(',');
    if (usedFocus.has(focusKey)) continue;
    picked.push(c.q);
    usedFocus.add(focusKey);
  }
  return picked;
}

export type MovePreview = {
  from: Square;
  to: Square;
  san: string;
  /** FEN of the position BEFORE this move (board state shown to the player). */
  fenBefore: string;
  /** FEN AFTER the move (used to compute the answer). */
  fenAfter: string;
  /** Piece type that is moving. */
  pieceType: PieceSymbol;
  /** Color of the moving piece. */
  pieceColor: Color;
  /** Correct controlled squares from the destination. */
  correctSquares: Square[];
};

/** Build a preview question for `move` applied to `fen`. Returns null if illegal. */
export function buildMovePreview(fen: string, moveUci: string): MovePreview | null {
  const chess = new Chess(fen);
  const from = moveUci.slice(0, 2) as Square;
  const to = moveUci.slice(2, 4) as Square;
  const promotion = moveUci.length >= 5 ? moveUci[4] : undefined;
  const piece = chess.get(from);
  if (!piece) return null;
  let move;
  try {
    move = chess.move({ from, to, promotion });
  } catch {
    return null;
  }
  if (!move) return null;
  const fenAfter = chess.fen();
  const correctSquares = squaresControlledBy(fenAfter, to);
  return {
    from,
    to,
    san: move.san,
    fenBefore: fen,
    fenAfter,
    pieceType: piece.type,
    pieceColor: piece.color,
    correctSquares,
  };
}

export type AnswerVerdict = {
  correct: Square[];
  missed: Square[];
  wrong: Square[];
  isPerfect: boolean;
};

export function gradeAnswer(selected: Square[], correctSquares: Square[]): AnswerVerdict {
  const correctSet = new Set(correctSquares);
  const selectedSet = new Set(selected);
  const correct: Square[] = [];
  const wrong: Square[] = [];
  for (const s of selected) {
    if (correctSet.has(s)) correct.push(s);
    else wrong.push(s);
  }
  const missed: Square[] = correctSquares.filter((s) => !selectedSet.has(s));
  return { correct, missed, wrong, isPerfect: wrong.length === 0 && missed.length === 0 };
}

export function pieceTypeName(type: PieceSymbol): string {
  return PIECE_NAMES[type];
}
