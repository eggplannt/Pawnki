import { Chess, type Move, type PieceSymbol, type Square } from 'chess.js';
import { BUNDLED_PGN_CORPUS } from './vision-pgn-corpus';

/**
 * Master-level games used to seed the trainer. The corpus is bundled via the
 * sibling vision-pgn-corpus.ts module (generated from Lichess game exports of
 * top-tier accounts). Each game is parsed at module load; any that fail to
 * parse are silently dropped so a malformed entry can't break the trainer.
 *
 * Three classic immortals are kept inline as a guaranteed fallback when the
 * bundled corpus is empty.
 */
const PGN_CORPUS: { name: string; pgn: string }[] = [
  ...BUNDLED_PGN_CORPUS,
  {
    name: "Morphy vs Duke of Brunswick (Paris, 1858)",
    pgn: `1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7 8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7 14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0`,
  },
  {
    name: "Anderssen vs Kieseritzky, Immortal Game (London, 1851)",
    pgn: `1.e4 e5 2.f4 exf4 3.Bc4 Qh4+ 4.Kf1 b5 5.Bxb5 Nf6 6.Nf3 Qh6 7.d3 Nh5 8.Nh4 Qg5 9.Nf5 c6 10.g4 Nf6 11.Rg1 cxb5 12.h4 Qg6 13.h5 Qg5 14.Qf3 Ng8 15.Bxf4 Qf6 16.Nc3 Bc5 17.Nd5 Qxb2 18.Bd6 Bxg1 19.e5 Qxa1+ 20.Ke2 Na6 21.Nxg7+ Kd8 22.Qf6+ Nxf6 23.Be7# 1-0`,
  },
  {
    name: "Anderssen vs Dufresne, Evergreen Game (Berlin, 1852)",
    pgn: `1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.b4 Bxb4 5.c3 Ba5 6.d4 exd4 7.O-O d3 8.Qb3 Qf6 9.e5 Qg6 10.Re1 Nge7 11.Ba3 b5 12.Qxb5 Rb8 13.Qa4 Bb6 14.Nbd2 Bb7 15.Ne4 Qf5 16.Bxd3 Qh5 17.Nf6+ gxf6 18.exf6 Rg8 19.Rad1 Qxf3 20.Rxe7+ Nxe7 21.Qxd7+ Kxd7 22.Bf5+ Ke8 23.Bd7+ Kf8 24.Bxe7# 1-0`,
  },
];

export type CorpusGame = {
  name: string;
  /** Full game move list as UCI strings, e.g., "e2e4". */
  moves: string[];
};

let CORPUS: CorpusGame[] = [];

function moveToUci(m: Move): string {
  return `${m.from}${m.to}${m.promotion ?? ''}`;
}

function loadCorpus(): CorpusGame[] {
  const out: CorpusGame[] = [];
  for (const entry of PGN_CORPUS) {
    try {
      const chess = new Chess();
      chess.loadPgn(entry.pgn);
      const history = chess.history({ verbose: true });
      if (history.length < 12) continue; // need some middlegame to slice
      out.push({ name: entry.name, moves: history.map(moveToUci) });
    } catch {
      /* skip games that don't parse cleanly — guards against typos */
    }
  }
  return out;
}

CORPUS = loadCorpus();

export const OPENING_SEEDS: { name: string; sans: string[] }[] = [
  { name: 'Italian',                  sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'] },
  { name: 'Ruy Lopez',                sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6'] },
  { name: 'Sicilian Najdorf',         sans: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'] },
  { name: 'French Winawer',           sans: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Bb4'] },
  { name: 'Caro-Kann',                sans: ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4'] },
  { name: "Queen's Gambit Declined",  sans: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7'] },
  { name: 'Slav',                     sans: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'dxc4'] },
  { name: "King's Indian",            sans: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6'] },
  { name: 'Nimzo-Indian',             sans: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'] },
  { name: 'English',                  sans: ['c4', 'e5', 'Nc3', 'Nf6', 'g3', 'd5'] },
  { name: 'London',                   sans: ['d4', 'Nf6', 'Nf3', 'd5', 'Bf4', 'c5', 'e3'] },
  { name: 'Catalan',                  sans: ['d4', 'Nf6', 'c4', 'e6', 'g3', 'd5', 'Bg2'] },
];

const OFFLINE_FALLBACKS: { name: string; fen: string }[] = [
  { name: 'QGD middlegame',       fen: 'r1bqk2r/pp2bppp/2n1pn2/2pp4/3P4/2P1PN2/PP1NBPPP/R1BQK2R w KQkq - 0 7' },
  { name: 'Najdorf',              fen: 'r1bqkb1r/pp2pppp/2np1n2/8/3NP3/2N5/PPP1BPPP/R1BQK2R b KQkq - 1 6' },
  { name: 'Italian classical',    fen: 'r1bq1rk1/ppp2ppp/2n2n2/2bpp3/4P3/2NP1N2/PPP1BPPP/R1BQ1RK1 w - - 0 8' },
  { name: "King's Indian",        fen: 'rnbq1rk1/ppp1ppbp/3p1np1/8/2PPP3/2N2N2/PP2BPPP/R1BQK2R w KQ - 2 7' },
  { name: 'Nimzo middlegame',     fen: 'r1bqr1k1/ppp2ppp/2n2n2/3p4/1b1P4/2NBPN2/PP3PPP/R1BQ1RK1 w - - 3 9' },
];

export type Scene = {
  /** Starting FEN — the position the player first sees. */
  fen: string;
  /** Human-readable source label ("Morphy vs Duke …", "Italian Opening", etc.). */
  source: string;
  /**
   * Remaining UCI moves from the source game. The trainer will replay these in order.
   * When this list is exhausted, the trainer falls back to a heuristic move picker.
   */
  remainingMoves: string[];
};

function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Build a scene by slicing into a random corpus game at a middlegame ply. */
export function buildSceneFromCorpus(): Scene | null {
  if (CORPUS.length === 0) return null;
  // Try a few games — short ones may not have enough plies to slice into.
  for (let attempt = 0; attempt < 6; attempt++) {
    const game = CORPUS[Math.floor(Math.random() * CORPUS.length)];
    const minStart = 10;
    const maxStart = Math.min(game.moves.length - 6, 22);
    if (maxStart < minStart) continue;
    const startPly = randInt(minStart, maxStart);
    const chess = new Chess();
    let ok = true;
    for (let i = 0; i < startPly; i++) {
      try {
        const uci = game.moves[i];
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
      } catch {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    return {
      fen: chess.fen(),
      source: game.name,
      remainingMoves: game.moves.slice(startPly),
    };
  }
  return null;
}

/** Build a scene by playing an opening seed track into a fresh game. */
export function buildSceneFromOpeningSeed(): Scene {
  const seed = OPENING_SEEDS[Math.floor(Math.random() * OPENING_SEEDS.length)];
  const chess = new Chess();
  for (const san of seed.sans) {
    try { chess.move(san); } catch { /* the seed is canonical; this shouldn't happen */ }
  }
  // Play a few more heuristic moves to dilute the opening pattern.
  for (let i = 0; i < randInt(4, 10); i++) {
    const next = pickHeuristicMove(chess.fen());
    if (!next) break;
    try {
      chess.move({ from: next.slice(0, 2), to: next.slice(2, 4), promotion: next.slice(4) || undefined });
    } catch {
      break;
    }
  }
  return { fen: chess.fen(), source: seed.name, remainingMoves: [] };
}

/** Build a scene by picking a hardcoded offline FEN. Last-resort fallback. */
export function buildSceneFromOfflineFallback(): Scene {
  const pick = OFFLINE_FALLBACKS[Math.floor(Math.random() * OFFLINE_FALLBACKS.length)];
  return { fen: pick.fen, source: pick.name, remainingMoves: [] };
}

/** Top-level: prefer corpus → opening seed → offline FEN. */
export function buildScene(): Scene {
  return buildSceneFromCorpus() ?? buildSceneFromOpeningSeed();
}

// ── Heuristic move picker ──────────────────────────────────────────────────
const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1, n: 3, b: 3.2, r: 5, q: 9, k: 0,
};

const CENTER_4: ReadonlyArray<Square> = ['d4', 'd5', 'e4', 'e5'];
const CENTER_RING: ReadonlyArray<Square> = ['c4', 'c5', 'f4', 'f5', 'd3', 'd6', 'e3', 'e6'];

function scoreMove(chess: Chess, move: Move): number {
  let score = 0;

  if (move.captured) score += PIECE_VALUES[move.captured] * 2;
  if (move.promotion) score += (PIECE_VALUES[move.promotion] ?? 0) - 1;

  if (CENTER_4.includes(move.to as Square)) score += 0.5;
  else if (CENTER_RING.includes(move.to as Square)) score += 0.25;

  // Develop minor pieces off their starting rank
  const backRank = move.color === 'w' ? '1' : '8';
  if ((move.piece === 'n' || move.piece === 'b') && move.from.endsWith(backRank)) {
    score += 0.4;
  }

  if (move.san === 'O-O' || move.san === 'O-O-O') score += 0.7;

  // Discourage frivolous queen sallies
  if (move.piece === 'q' && chess.moveNumber() < 8) score -= 0.5;

  if (move.san.endsWith('+') || move.san.endsWith('#')) score += 0.2;

  // Cheap hanging check: would the moving piece be attacked on its new square
  // with no defenders? Penalize harshly.
  const trial = new Chess(chess.fen());
  try {
    trial.move({ from: move.from, to: move.to, promotion: move.promotion });
  } catch {
    return -Infinity;
  }
  const us = move.color;
  const them = us === 'w' ? 'b' : 'w';
  const enemyAttackers = trial.attackers(move.to as Square, them) ?? [];
  if (enemyAttackers.length > 0) {
    const defenders = trial.attackers(move.to as Square, us) ?? [];
    const ourValue = PIECE_VALUES[move.piece];
    if (defenders.length === 0) {
      score -= ourValue * 1.6;
    } else {
      // Very rough SEE: if the cheapest enemy attacker is worth less than us, it's still bad.
      const cheapest = Math.min(
        ...enemyAttackers.map((sq) => {
          const p = trial.get(sq);
          return p ? PIECE_VALUES[p.type] : 0;
        }),
      );
      if (cheapest > 0 && cheapest < ourValue) score -= (ourValue - cheapest) * 0.9;
    }
  }

  // Light noise so we get variety even from the same position.
  score += Math.random() * 0.4;
  return score;
}

/** Pick a plausible-looking move for `fen` using a simple heuristic. Returns UCI or null. */
export function pickHeuristicMove(fen: string): string | null {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return null;
  let best: Move | null = null;
  let bestScore = -Infinity;
  for (const m of moves) {
    const s = scoreMove(chess, m);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  if (!best) return null;
  return moveToUci(best);
}

/**
 * Pick the next move for the session. If the scene has remaining scripted moves,
 * play the next one. Otherwise fall back to the heuristic.
 *
 * Mutates `scene.remainingMoves` (shifts the played move off the front).
 */
export function pickNextMove(fen: string, scene: Scene): string | null {
  while (scene.remainingMoves.length > 0) {
    const candidate = scene.remainingMoves.shift()!;
    // Defensive: only use the scripted move if it's actually legal from `fen`.
    // If our session-driven FEN diverges (shouldn't, but just in case), drop the
    // candidate and try the next one.
    try {
      const trial = new Chess(fen);
      trial.move({
        from: candidate.slice(0, 2),
        to: candidate.slice(2, 4),
        promotion: candidate.slice(4) || undefined,
      });
      return candidate;
    } catch {
      continue;
    }
  }
  return pickHeuristicMove(fen);
}

export const CORPUS_SIZE = CORPUS.length;
