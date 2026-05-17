import { Chess } from 'chess.js';

/**
 * Strip halfmove clock + fullmove number from a FEN so move-order
 * variations of the same position compare equal.
 */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export interface PgnNode {
  move_san: string | null; // null for root
  move_uci: string | null;
  fen: string;
  annotation: string | null;
  children: PgnNode[];
}

/**
 * Parse a PGN string (one or many games) into a single merged tree.
 * Multiple games sharing the same opening moves are auto-merged by FEN.
 * Variations within each game are preserved as branches.
 */
export function parsePgn(pgn: string): PgnNode {
  const games = splitGames(pgn);
  const trees = games.map(parseOneGame);
  if (trees.length === 0) {
    return { move_san: null, move_uci: null, fen: new Chess().fen(), annotation: null, children: [] };
  }
  // Merge all game trees into one
  let merged = trees[0];
  for (let i = 1; i < trees.length; i++) {
    merged = mergeTrees(merged, trees[i]);
  }
  return merged;
}

/** Split a multi-game PGN string into individual game strings. */
function splitGames(pgn: string): string[] {
  // Split on [Event lines (the standard first tag of each game)
  const parts = pgn.split(/(?=\[Event\s)/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Merge two PgnNode trees by FEN. If both trees have a child reaching
 * the same FEN, their subtrees are merged recursively. Otherwise the
 * child is added as a new branch.
 */
function mergeTrees(a: PgnNode, b: PgnNode): PgnNode {
  // Start from the root — both should share the same starting FEN
  const merged: PgnNode = {
    move_san: a.move_san,
    move_uci: a.move_uci,
    fen: a.fen,
    annotation: a.annotation ?? b.annotation,
    children: [...a.children],
  };

  for (const bChild of b.children) {
    // Look for an existing child with the same FEN (same position reached)
    const match = merged.children.find((c) => positionKey(c.fen) === positionKey(bChild.fen));
    if (match) {
      // Same position — merge recursively
      const idx = merged.children.indexOf(match);
      merged.children[idx] = mergeTrees(match, bChild);
    } else {
      // New branch — add it
      merged.children.push(bChild);
    }
  }

  return merged;
}

// ── Single-game parser ──────────────────────────────────────────────────────

function parseOneGame(pgn: string): PgnNode {
  const tokens = tokenize(pgn);
  const chess = new Chess();
  const root: PgnNode = {
    move_san: null,
    move_uci: null,
    fen: chess.fen(),
    annotation: null,
    children: [],
  };
  parseTokens(tokens, { pos: 0 }, chess, root);
  return root;
}

type Token =
  | { type: 'move'; value: string }
  | { type: 'comment'; value: string }
  | { type: 'open_paren' }
  | { type: 'close_paren' }
  | { type: 'result'; value: string };

function tokenize(pgn: string): Token[] {
  const tokens: Token[] = [];
  // Strip tag pairs [Tag "value"]
  const body = pgn.replace(/\[[^\]]*\]/g, '').trim();
  let i = 0;

  while (i < body.length) {
    const ch = body[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Comment
    if (ch === '{') {
      const end = body.indexOf('}', i + 1);
      if (end === -1) break;
      tokens.push({ type: 'comment', value: body.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }

    // Variation
    if (ch === '(') {
      tokens.push({ type: 'open_paren' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'close_paren' });
      i++;
      continue;
    }

    // Move number (skip): 1. or 1... or 12.
    if (/\d/.test(ch)) {
      let j = i;
      while (j < body.length && /[\d.]/.test(body[j])) j++;
      const num = body.slice(i, j);
      // If it's a result like 1-0, 0-1, 1/2-1/2
      if (/^(1-0|0-1|1\/2-1\/2)$/.test(num)) {
        tokens.push({ type: 'result', value: num });
      }
      // Also check for results that start with digits
      if (j < body.length && body[j] === '-') {
        const rest = body.slice(i, Math.min(i + 7, body.length));
        const resultMatch = rest.match(/^(1-0|0-1|1\/2-1\/2)/);
        if (resultMatch) {
          tokens.push({ type: 'result', value: resultMatch[1] });
          i += resultMatch[1].length;
          continue;
        }
      }
      // Otherwise just a move number, skip
      i = j;
      // Skip trailing spaces
      while (i < body.length && /\s/.test(body[i])) i++;
      continue;
    }

    // Result *
    if (ch === '*') {
      tokens.push({ type: 'result', value: '*' });
      i++;
      continue;
    }

    // Must be a move (SAN)
    let j = i;
    while (j < body.length && !/[\s{}()]/.test(body[j])) j++;
    const moveStr = body.slice(i, j);
    // Filter out results that look like moves
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(moveStr)) {
      tokens.push({ type: 'result', value: moveStr });
    } else if (moveStr.length > 0) {
      tokens.push({ type: 'move', value: moveStr });
    }
    i = j;
  }

  return tokens;
}

interface Cursor {
  pos: number;
}

function parseTokens(
  tokens: Token[],
  cursor: Cursor,
  chess: Chess,
  parent: PgnNode,
): void {
  let currentParent = parent;

  while (cursor.pos < tokens.length) {
    const token = tokens[cursor.pos];

    if (token.type === 'close_paren') {
      // End of variation — don't consume, let caller handle it
      return;
    }

    if (token.type === 'result') {
      cursor.pos++;
      continue;
    }

    if (token.type === 'comment') {
      // Attach comment to the most recent node
      if (currentParent !== parent || currentParent.move_san !== null) {
        currentParent.annotation = token.value;
      }
      cursor.pos++;
      continue;
    }

    if (token.type === 'open_paren') {
      // Variation: branch from the parent of the last move
      cursor.pos++;
      const variationChess = new Chess(
        currentParent === parent ? parent.fen : getParentFen(parent, currentParent),
      );
      const variationParent =
        currentParent === parent ? parent : findParentOf(parent, currentParent) ?? parent;
      parseTokens(tokens, cursor, variationChess, variationParent);
      // Consume the closing paren
      if (cursor.pos < tokens.length && tokens[cursor.pos].type === 'close_paren') {
        cursor.pos++;
      }
      continue;
    }

    if (token.type === 'move') {
      const result = chess.move(token.value);
      if (!result) {
        // Invalid move — skip
        cursor.pos++;
        continue;
      }

      const fen = chess.fen();

      // Check if this parent already has a child with this position (merge within a game too)
      const existing = currentParent.children.find((c) => positionKey(c.fen) === positionKey(fen));
      if (existing) {
        currentParent = existing;
      } else {
        const node: PgnNode = {
          move_san: result.san,
          move_uci: result.from + result.to + (result.promotion ?? ''),
          fen,
          annotation: null,
          children: [],
        };
        currentParent.children.push(node);
        currentParent = node;
      }
      cursor.pos++;
      continue;
    }

    cursor.pos++;
  }
}

function getParentFen(root: PgnNode, target: PgnNode): string {
  const path = findPath(root, target);
  if (path && path.length >= 2) {
    return path[path.length - 2].fen;
  }
  return root.fen;
}

function findParentOf(root: PgnNode, target: PgnNode): PgnNode | null {
  const path = findPath(root, target);
  if (path && path.length >= 2) {
    return path[path.length - 2];
  }
  return null;
}

function findPath(root: PgnNode, target: PgnNode): PgnNode[] | null {
  if (root === target) return [root];
  for (const child of root.children) {
    const result = findPath(child, target);
    if (result) return [root, ...result];
  }
  return null;
}

// ── Flatten for DB insert ───────────────────────────────────────────────────

export interface FlatNode {
  move_san: string | null;
  move_uci: string | null;
  fen: string;
  annotation: string | null;
  sort_order: number;
  _tempId: number;
  _parentTempId: number | null;
}

export function flattenTree(root: PgnNode): FlatNode[] {
  const result: FlatNode[] = [];
  let nextId = 0;

  function walk(node: PgnNode, parentTempId: number | null) {
    const tempId = nextId++;
    result.push({
      move_san: node.move_san,
      move_uci: node.move_uci,
      fen: node.fen,
      annotation: node.annotation,
      sort_order: tempId,
      _tempId: tempId,
      _parentTempId: parentTempId,
    });
    for (const child of node.children) {
      walk(child, tempId);
    }
  }

  walk(root, null);
  return result;
}
