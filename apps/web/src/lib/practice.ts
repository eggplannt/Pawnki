import type { Node } from '@/types';

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Side whose turn it is at `fen`. */
export function fenSide(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'w' ? 'white' : 'black';
}

/** A node is a "user move" iff its move_san was played by the user (i.e. the
 *  side that moved into this position was the user's color). Equivalently:
 *  the side-to-move AT this position is the opponent. */
export function isUserMove(node: Node, userColor: 'white' | 'black'): boolean {
  return node.move_san !== null && fenSide(node.fen) !== userColor;
}

/** A decision point: a position where the user must choose their next move.
 *  The user is choosing among children — each child is a candidate user move. */
export function isUserDecision(node: Node, userColor: 'white' | 'black'): boolean {
  return fenSide(node.fen) === userColor && (node.children?.length ?? 0) > 0;
}

// ── Session types ───────────────────────────────────────────────────────────

export type PracticeMode = 'learn' | 'practice';

export interface PracticeOptions {
  mode: PracticeMode;
  userColor: 'white' | 'black';
  /** Root of the practice subtree — root of opening, or any selected node. */
  rootNode: Node;
  /** Set of node ids that already have a review_cards row (i.e. are "learned"). */
  learnedNodeIds: Set<string>;
  /** First-child auto-play for opponent (true) vs random (false). Default true. */
  opponentPicksFirst?: boolean;
}

export interface PracticeMistake {
  nodeId: string;          // the decision point where the wrong move was attempted
  attemptedSan: string;
  expectedSans: string[];  // all currently-applicable correct SANs
}

export interface PracticeSession {
  options: PracticeOptions;
  /** Position the user is currently looking at. */
  currentNode: Node;
  /** Subtree-root ids whose DFS has been completed this session — skipped on backtrack. */
  practicedChildIds: Set<string>;
  /** User-move node ids reached this session whose subtree we descended into. */
  visitedUserMoves: Set<string>;
  /** Per-mode applicable counts per node id (precomputed at start). */
  applicableCounts: Map<string, number>;
  /** Set of node ids reachable from root (subtree scope) for fast membership tests. */
  inScopeIds: Set<string>;
  mistakes: PracticeMistake[];
  hintsUsed: Set<string>;
  totalApplicable: number;
  completedApplicable: number;
  /** 0 = no hint shown; 1 = piece highlight; 2 = answer revealed. Resets per decision. */
  hintLevel: 0 | 1 | 2;
  /** Wrong attempts at the current decision (resets on advance). */
  wrongAttemptsHere: number;
  status: 'awaiting-user' | 'opponent-to-move' | 'complete';
}

export interface AttemptResult {
  session: PracticeSession;
  verdict:
    | 'correct'
    | 'wrong'                // standard wrong, count as mistake, allow retry
    | 'wrong-disallowed'     // already practiced this session — soft reject
    | 'wrong-mode';          // valid move in tree, but not allowed by mode filter
  /** Set when verdict==='correct': the child the user advanced into. */
  target?: Node;
  /** Brief explanation for the toast/banner when verdict !== 'correct'. */
  reason?: string;
}

// ── Tree precomputation ─────────────────────────────────────────────────────

/**
 * Compute applicableCounts for every node in `root`'s subtree.
 *
 * - Learn mode: count every unlearned user-move descendant (including self).
 * - Practice mode: count learned user-move nodes reachable via paths of
 *   exclusively learned user moves. Once we cross an unlearned user move we
 *   stop counting beyond it.
 */
export function computeApplicableCounts(
  root: Node,
  userColor: 'white' | 'black',
  learnedIds: Set<string>,
  mode: PracticeMode,
): Map<string, number> {
  const out = new Map<string, number>();
  function walkLearn(n: Node): number {
    const selfHit = isUserMove(n, userColor) && !learnedIds.has(n.id) ? 1 : 0;
    let total = selfHit;
    for (const c of n.children ?? []) total += walkLearn(c);
    out.set(n.id, total);
    return total;
  }
  function walkPractice(n: Node): number {
    if (isUserMove(n, userColor)) {
      if (!learnedIds.has(n.id)) {
        // Stop here — Practice never traverses beyond an unlearned user move.
        out.set(n.id, 0);
        return 0;
      }
      let total = 1;
      for (const c of n.children ?? []) total += walkPractice(c);
      out.set(n.id, total);
      return total;
    }
    // Opponent move or root: pass-through.
    let total = 0;
    for (const c of n.children ?? []) total += walkPractice(c);
    out.set(n.id, total);
    return total;
  }
  if (mode === 'learn') walkLearn(root);
  else walkPractice(root);
  return out;
}

function collectIds(root: Node, out: Set<string>) {
  out.add(root.id);
  for (const c of root.children ?? []) collectIds(c, out);
}

// ── Session lifecycle ───────────────────────────────────────────────────────

export function startSession(opts: PracticeOptions): PracticeSession {
  const applicableCounts = computeApplicableCounts(
    opts.rootNode,
    opts.userColor,
    opts.learnedNodeIds,
    opts.mode,
  );
  const inScopeIds = new Set<string>();
  collectIds(opts.rootNode, inScopeIds);

  const total = applicableCounts.get(opts.rootNode.id) ?? 0;
  const session: PracticeSession = {
    options: opts,
    currentNode: opts.rootNode,
    practicedChildIds: new Set(),
    visitedUserMoves: new Set(),
    applicableCounts,
    inScopeIds,
    mistakes: [],
    hintsUsed: new Set(),
    totalApplicable: total,
    completedApplicable: 0,
    hintLevel: 0,
    wrongAttemptsHere: 0,
    status: total === 0 ? 'complete' : nextStatus(opts.rootNode, opts.userColor),
  };
  return session;
}

function nextStatus(
  node: Node,
  userColor: 'white' | 'black',
): 'awaiting-user' | 'opponent-to-move' {
  return fenSide(node.fen) === userColor ? 'awaiting-user' : 'opponent-to-move';
}

// ── Applicable / disallowed children at currentNode ─────────────────────────

/**
 * Children of `currentNode` that are valid next steps right now, after mode
 * filtering and excluding already-practiced subtrees this session.
 */
export function applicableChildren(session: PracticeSession): Node[] {
  const { currentNode, options, applicableCounts, practicedChildIds } = session;
  const children = currentNode.children ?? [];
  const userIsToMove = fenSide(currentNode.fen) === options.userColor;
  return children.filter((c) => {
    if (practicedChildIds.has(c.id)) return false;
    if (userIsToMove) {
      // At a user decision, mode filter applies to the chosen child.
      if (options.mode === 'learn') {
        // Allowed if its subtree still has unlearned descendants.
        return (applicableCounts.get(c.id) ?? 0) > 0;
      } else {
        // Practice: the chosen move itself must be learned.
        return options.learnedNodeIds.has(c.id);
      }
    } else {
      // Opponent move — engine plays it; prune if subtree has no applicable nodes.
      return (applicableCounts.get(c.id) ?? 0) > 0;
    }
  });
}

/** Children that exist but are disallowed (used to give better feedback). */
export function disallowedChildren(session: PracticeSession): Array<{
  child: Node;
  reason: 'already-practiced' | 'already-learned' | 'not-learned';
}> {
  const { currentNode, options, practicedChildIds, applicableCounts } = session;
  const userIsToMove = fenSide(currentNode.fen) === options.userColor;
  const out: Array<{ child: Node; reason: 'already-practiced' | 'already-learned' | 'not-learned' }> = [];
  for (const c of currentNode.children ?? []) {
    if (practicedChildIds.has(c.id)) { out.push({ child: c, reason: 'already-practiced' }); continue; }
    if (!userIsToMove) continue;
    if (options.mode === 'learn') {
      if ((applicableCounts.get(c.id) ?? 0) === 0) out.push({ child: c, reason: 'already-learned' });
    } else {
      if (!options.learnedNodeIds.has(c.id)) out.push({ child: c, reason: 'not-learned' });
    }
  }
  return out;
}

// ── User attempt ────────────────────────────────────────────────────────────

export function attemptMove(session: PracticeSession, san: string): AttemptResult {
  if (session.status !== 'awaiting-user') {
    return { session, verdict: 'wrong', reason: 'Not your turn.' };
  }
  const all = session.currentNode.children ?? [];
  const match = all.find((c) => c.move_san === san);
  if (!match) {
    const mistake: PracticeMistake = {
      nodeId: session.currentNode.id,
      attemptedSan: san,
      expectedSans: applicableChildren(session).map((c) => c.move_san!).filter(Boolean),
    };
    const next: PracticeSession = {
      ...session,
      wrongAttemptsHere: session.wrongAttemptsHere + 1,
      mistakes: [...session.mistakes, mistake],
    };
    return { session: next, verdict: 'wrong', reason: 'Not a move in this opening.' };
  }
  // Move exists, but check mode/scope filters.
  if (session.practicedChildIds.has(match.id)) {
    return {
      session,
      verdict: 'wrong-disallowed',
      reason: 'Already practiced this line in this session — try another move.',
    };
  }
  const userIsToMove = fenSide(session.currentNode.fen) === session.options.userColor;
  if (userIsToMove) {
    if (session.options.mode === 'learn') {
      if ((session.applicableCounts.get(match.id) ?? 0) === 0) {
        return {
          session,
          verdict: 'wrong-mode',
          reason: 'That branch is already learned — pick an unlearned move.',
        };
      }
    } else {
      if (!session.options.learnedNodeIds.has(match.id)) {
        return {
          session,
          verdict: 'wrong-mode',
          reason: 'That move hasn\'t been learned yet — use Learn mode first.',
        };
      }
    }
  }
  // Correct! Advance.
  const visited = new Set(session.visitedUserMoves);
  let completed = session.completedApplicable;
  if (isUserMove(match, session.options.userColor)) {
    // Count this as completed only if it matched the mode filter (was applicable
    // at session start). For learn: unlearned. For practice: learned.
    const wasApplicableSelf =
      session.options.mode === 'learn'
        ? !session.options.learnedNodeIds.has(match.id)
        : session.options.learnedNodeIds.has(match.id);
    if (wasApplicableSelf && !visited.has(match.id)) {
      visited.add(match.id);
      completed += 1;
    }
  }
  const advanced: PracticeSession = {
    ...session,
    currentNode: match,
    visitedUserMoves: visited,
    completedApplicable: completed,
    hintLevel: 0,
    wrongAttemptsHere: 0,
    status: nextStatus(match, session.options.userColor),
  };
  return { session: settleIfLeaf(advanced), verdict: 'correct', target: match };
}

// ── Opponent auto-play ──────────────────────────────────────────────────────

/** Advance one opponent move. Returns the new session + the played node. */
export function opponentMove(session: PracticeSession): { session: PracticeSession; played: Node | null } {
  if (session.status !== 'opponent-to-move') return { session, played: null };
  const allowed = applicableChildren(session);
  if (allowed.length === 0) return { session: backtrack(session), played: null };
  const pick = session.options.opponentPicksFirst === false
    ? allowed[Math.floor(Math.random() * allowed.length)]
    : allowed[0];
  const advanced: PracticeSession = {
    ...session,
    currentNode: pick,
    hintLevel: 0,
    wrongAttemptsHere: 0,
    status: nextStatus(pick, session.options.userColor),
  };
  return { session: settleIfLeaf(advanced), played: pick };
}

// ── Backtracking ────────────────────────────────────────────────────────────

/**
 * If currentNode has no more applicable children, mark this branch done and
 * walk up the tree until we find an ancestor that still has unpracticed
 * applicable children — that becomes the new current. If we walk past the
 * root, the session is complete.
 *
 * The tree itself doesn't carry parent pointers, so we re-walk from root.
 */
function settleIfLeaf(session: PracticeSession): PracticeSession {
  if (applicableChildren(session).length === 0) return backtrack(session);
  return session;
}

export function backtrack(session: PracticeSession): PracticeSession {
  const path = findPath(session.options.rootNode, session.currentNode.id);
  if (!path || path.length === 0) {
    return { ...session, status: 'complete' };
  }
  const practiced = new Set(session.practicedChildIds);
  // Mark current as done, then walk up until an ancestor still has work.
  practiced.add(session.currentNode.id);
  for (let i = path.length - 2; i >= 0; i--) {
    const ancestor = path[i];
    const candidates = (ancestor.children ?? []).filter((c) => !practiced.has(c.id) && isApplicableChild(session, ancestor, c));
    if (candidates.length > 0) {
      return {
        ...session,
        currentNode: ancestor,
        practicedChildIds: practiced,
        hintLevel: 0,
        wrongAttemptsHere: 0,
        status: nextStatus(ancestor, session.options.userColor),
      };
    }
    practiced.add(ancestor.id);
  }
  return {
    ...session,
    practicedChildIds: practiced,
    status: 'complete',
  };
}

function isApplicableChild(session: PracticeSession, parent: Node, child: Node): boolean {
  const userIsToMove = fenSide(parent.fen) === session.options.userColor;
  if (userIsToMove) {
    if (session.options.mode === 'learn') return (session.applicableCounts.get(child.id) ?? 0) > 0;
    return session.options.learnedNodeIds.has(child.id);
  }
  return (session.applicableCounts.get(child.id) ?? 0) > 0;
}

function findPath(root: Node, targetId: string): Node[] | null {
  if (root.id === targetId) return [root];
  for (const c of root.children ?? []) {
    const sub = findPath(c, targetId);
    if (sub) return [root, ...sub];
  }
  return null;
}

// ── Hints ───────────────────────────────────────────────────────────────────

export interface HintInfo {
  level: 1 | 2;
  /** From-squares of allowed moves; UI highlights these. */
  fromSquares: string[];
  /** SANs of allowed moves; only used at level 2. */
  sans?: string[];
}

/**
 * Reveal one level of hint. Level 1 = piece highlight; level 2 = answer.
 * Marks current node as "hinted" but doesn't penalize correctness.
 */
export function showHint(session: PracticeSession, level: 1 | 2): { session: PracticeSession; hint: HintInfo } {
  const allowed = applicableChildren(session);
  const fromSquares = Array.from(new Set(allowed.map((c) => (c.move_uci ?? '').slice(0, 2)).filter(Boolean)));
  const sans = allowed.map((c) => c.move_san!).filter(Boolean);
  const hintsUsed = new Set(session.hintsUsed);
  hintsUsed.add(session.currentNode.id);
  const newLevel: 0 | 1 | 2 = level > session.hintLevel ? level : session.hintLevel;
  return {
    session: { ...session, hintLevel: newLevel, hintsUsed },
    hint: { level, fromSquares, sans: level === 2 ? sans : undefined },
  };
}

// ── Finalize ────────────────────────────────────────────────────────────────

export interface SessionSummary {
  totalApplicable: number;
  completedApplicable: number;
  mistakes: PracticeMistake[];
  hintedNodeIds: string[];
  /** User-move nodes visited this session that should get review_cards if not
   *  already learned. */
  visitedUserMoveIds: string[];
}

export function finalize(session: PracticeSession): SessionSummary {
  return {
    totalApplicable: session.totalApplicable,
    completedApplicable: session.completedApplicable,
    mistakes: session.mistakes,
    hintedNodeIds: Array.from(session.hintsUsed),
    visitedUserMoveIds: Array.from(session.visitedUserMoves),
  };
}
