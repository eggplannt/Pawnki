import type { Node } from '../types';

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

/**
 * Walk the tree and mark each user-move node as learnable iff its parent's
 * decision has exactly one user-move child (= unique response).
 * Branching positions (parent with multiple user-move children) aren't
 * learnable: there's no single "correct" answer to memorize. They remain
 * practicable but never get review_cards rows.
 */
export function computeLearnableMap(
  root: Node,
  userColor: 'white' | 'black',
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  function walk(n: Node) {
    const userKids = (n.children ?? []).filter((c) => isUserMove(c, userColor));
    const unique = userKids.length === 1;
    for (const c of n.children ?? []) {
      out.set(c.id, isUserMove(c, userColor) ? unique : false);
      walk(c);
    }
  }
  out.set(root.id, false);
  walk(root);
  return out;
}

/**
 * Walk the tree and return an augmented learned set that also includes any
 * learnable user-move node whose position_key appears in
 * `crossLearnedPositionKeys` — i.e. the same position with the same unique
 * response was already learned in another opening (trunk transposition).
 */
export function augmentLearnedWithTranspositions(
  root: Node,
  userColor: 'white' | 'black',
  learnedNodeIds: Set<string>,
  learnableMap: Map<string, boolean>,
  crossLearnedPositionKeys: Set<string>,
): Set<string> {
  if (crossLearnedPositionKeys.size === 0) return learnedNodeIds;
  const augmented = new Set(learnedNodeIds);
  function walk(n: Node) {
    if (
      isUserMove(n, userColor) &&
      (learnableMap.get(n.id) ?? false) &&
      !augmented.has(n.id) &&
      crossLearnedPositionKeys.has(n.position_key)
    ) {
      augmented.add(n.id);
    }
    for (const c of n.children ?? []) walk(c);
  }
  walk(root);
  return augmented;
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
  /** Shuffle the order positions are drilled each session. */
  randomizeOrder?: boolean;
}

export interface PracticeMistake {
  nodeId: string;          // the decision point where the wrong move was attempted
  attemptedSan: string;
  expectedSans: string[];  // all currently-applicable correct SANs
}

export interface PracticeSession {
  options: PracticeOptions;
  /** Per-node ordered children ids — shuffled at session start when randomizeOrder is on. */
  childOrderMap: Map<string, string[]>;
  /** Position the user is currently looking at. */
  currentNode: Node;
  /** Subtree-root ids whose DFS has been completed this session — skipped on backtrack. */
  practicedChildIds: Set<string>;
  /** Learn mode: user-move ids the user picked correctly with ZERO wrong attempts
   *  at the parent. These (and only these) become review_cards at finalize.
   *  Practice mode: every applicable user-move correctly visited. */
  firstTryCorrect: Set<string>;
  /** Learn mode only: decisions to re-prompt after main DFS completes because
   *  the user had at least one wrong attempt at them. Processed FIFO. */
  requeueEntries: Array<{ parentId: string; childId: string }>;
  /** 'main' = DFS through the tree; 'requeue' = re-prompting tainted decisions. */
  phase: 'main' | 'requeue';
  /** Per-mode applicable counts per node id (precomputed at start). */
  applicableCounts: Map<string, number>;
  /** Node id → whether that user-move is the unique response at its parent
   *  (and therefore reviewable). Branching positions are not learnable. */
  learnableMap: Map<string, boolean>;
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
 * - Learn mode: count unlearned LEARNABLE (unique-response) user-move
 *   descendants. Branching user-moves aren't counted (not reviewable) but
 *   DFS still walks through them to reach learnables deeper in the tree.
 * - Practice mode: count practicable user-moves. A user-move is practicable
 *   iff it's a learned learnable OR a branching (non-learnable) move. When
 *   we hit an unlearned learnable we stop — can't practice past unknown.
 */
export function computeApplicableCounts(
  root: Node,
  userColor: 'white' | 'black',
  learnedIds: Set<string>,
  mode: PracticeMode,
  learnableMap?: Map<string, boolean>,
): Map<string, number> {
  const lm = learnableMap ?? computeLearnableMap(root, userColor);
  const out = new Map<string, number>();
  function walkLearn(n: Node): number {
    const learnable = lm.get(n.id) ?? false;
    const selfHit = isUserMove(n, userColor) && learnable && !learnedIds.has(n.id) ? 1 : 0;
    let total = selfHit;
    for (const c of n.children ?? []) total += walkLearn(c);
    out.set(n.id, total);
    return total;
  }
  function walkPractice(n: Node): number {
    if (isUserMove(n, userColor)) {
      const learnable = lm.get(n.id) ?? false;
      if (learnable && !learnedIds.has(n.id)) {
        // Stop — can't practice past an unlearned unique-response.
        out.set(n.id, 0);
        return 0;
      }
      // Practicable: learnable+learned OR branching (always practicable).
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

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildChildOrderMap(root: Node, randomize: boolean): Map<string, string[]> {
  const map = new Map<string, string[]>();
  function walk(n: Node) {
    const ids = (n.children ?? []).map((c) => c.id);
    map.set(n.id, randomize ? shuffle(ids) : ids);
    for (const c of n.children ?? []) walk(c);
  }
  walk(root);
  return map;
}

// ── Session lifecycle ───────────────────────────────────────────────────────

export function startSession(opts: PracticeOptions): PracticeSession {
  const learnableMap = computeLearnableMap(opts.rootNode, opts.userColor);
  const applicableCounts = computeApplicableCounts(
    opts.rootNode,
    opts.userColor,
    opts.learnedNodeIds,
    opts.mode,
    learnableMap,
  );
  const inScopeIds = new Set<string>();
  collectIds(opts.rootNode, inScopeIds);
  const childOrderMap = buildChildOrderMap(opts.rootNode, opts.randomizeOrder ?? false);

  const total = applicableCounts.get(opts.rootNode.id) ?? 0;
  const session: PracticeSession = {
    options: opts,
    childOrderMap,
    currentNode: opts.rootNode,
    practicedChildIds: new Set(),
    firstTryCorrect: new Set(),
    requeueEntries: [],
    phase: 'main',
    applicableCounts,
    learnableMap,
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
  const { currentNode, options, applicableCounts, practicedChildIds, learnableMap, childOrderMap } = session;
  const childById = new Map((currentNode.children ?? []).map((c) => [c.id, c]));
  const orderedIds = childOrderMap.get(currentNode.id) ?? (currentNode.children ?? []).map((c) => c.id);
  const userIsToMove = fenSide(currentNode.fen) === options.userColor;
  return orderedIds.flatMap((id) => {
    const c = childById.get(id);
    if (!c) return [];
    if (practicedChildIds.has(c.id)) return [];
    if (userIsToMove) {
      if (options.mode === 'learn') {
        return (applicableCounts.get(c.id) ?? 0) > 0 ? [c] : [];
      } else {
        const learnable = learnableMap.get(c.id) ?? false;
        if (learnable) return options.learnedNodeIds.has(c.id) ? [c] : [];
        return (applicableCounts.get(c.id) ?? 0) > 0 ? [c] : [];
      }
    } else {
      return (applicableCounts.get(c.id) ?? 0) > 0 ? [c] : [];
    }
  });
}

/** Children that exist but are disallowed (used to give better feedback). */
export function disallowedChildren(session: PracticeSession): Array<{
  child: Node;
  reason: 'already-practiced' | 'already-learned' | 'not-learned';
}> {
  const { currentNode, options, practicedChildIds, applicableCounts, learnableMap } = session;
  const userIsToMove = fenSide(currentNode.fen) === options.userColor;
  const out: Array<{ child: Node; reason: 'already-practiced' | 'already-learned' | 'not-learned' }> = [];
  for (const c of currentNode.children ?? []) {
    if (practicedChildIds.has(c.id)) { out.push({ child: c, reason: 'already-practiced' }); continue; }
    if (!userIsToMove) continue;
    if (options.mode === 'learn') {
      if ((applicableCounts.get(c.id) ?? 0) === 0) out.push({ child: c, reason: 'already-learned' });
    } else {
      const learnable = learnableMap.get(c.id) ?? false;
      if (learnable && !options.learnedNodeIds.has(c.id)) {
        out.push({ child: c, reason: 'not-learned' });
      }
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
    return { session: next, verdict: 'wrong', reason: 'Wrong move.' };
  }
  // Move exists, but check mode/scope filters.
  if (session.phase === 'main' && session.practicedChildIds.has(match.id)) {
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
      const learnable = session.learnableMap.get(match.id) ?? false;
      if (learnable && !session.options.learnedNodeIds.has(match.id)) {
        return {
          session,
          verdict: 'wrong-mode',
          reason: 'That move hasn\'t been learned yet — use Learn mode first.',
        };
      }
    }
  }

  // Correct.
  const wasFirstTry = session.wrongAttemptsHere === 0;
  const matchLearnable = session.learnableMap.get(match.id) ?? false;
  const moveIsUserMove = isUserMove(match, session.options.userColor);
  const wasApplicableSelf = moveIsUserMove && (session.options.mode === 'learn'
    ? matchLearnable && !session.options.learnedNodeIds.has(match.id)
    : !matchLearnable || session.options.learnedNodeIds.has(match.id));

  // ── Requeue phase: don't descend, just dequeue and move on ────────────
  if (session.phase === 'requeue') {
    const queue = session.requeueEntries.slice(1); // drop the entry we just answered
    let firstTry = session.firstTryCorrect;
    let completed = session.completedApplicable;
    if (wasFirstTry && wasApplicableSelf && !firstTry.has(match.id)) {
      firstTry = new Set(firstTry);
      firstTry.add(match.id);
      completed += 1;
    } else if (!wasFirstTry && wasApplicableSelf) {
      // Tainted again — re-queue at end so they get another shot.
      queue.push({ parentId: session.currentNode.id, childId: match.id });
    }
    if (queue.length === 0) {
      return {
        session: {
          ...session,
          requeueEntries: queue,
          firstTryCorrect: firstTry,
          completedApplicable: completed,
          status: 'complete',
        },
        verdict: 'correct',
        target: match,
      };
    }
    const nextParent = findNodeById(session.options.rootNode, queue[0].parentId) ?? session.currentNode;
    return {
      session: {
        ...session,
        currentNode: nextParent,
        requeueEntries: queue,
        firstTryCorrect: firstTry,
        completedApplicable: completed,
        wrongAttemptsHere: 0,
        hintLevel: 0,
        status: 'awaiting-user',
      },
      verdict: 'correct',
      target: match,
    };
  }

  // ── Main phase: advance through the tree ──────────────────────────────
  let firstTry = session.firstTryCorrect;
  let completed = session.completedApplicable;
  let queue = session.requeueEntries;
  if (isUserMove(match, session.options.userColor) && wasApplicableSelf) {
    if (wasFirstTry) {
      if (!firstTry.has(match.id)) {
        firstTry = new Set(firstTry);
        firstTry.add(match.id);
        completed += 1;
      }
    } else if (session.options.mode === 'learn') {
      // Learn mode: tainted by a wrong attempt → queue for re-prompt at end.
      queue = [...queue, { parentId: session.currentNode.id, childId: match.id }];
    } else {
      // Practice mode: count as completed even with prior wrong attempts.
      if (!firstTry.has(match.id)) {
        firstTry = new Set(firstTry);
        firstTry.add(match.id);
        completed += 1;
      }
    }
  }
  const advanced: PracticeSession = {
    ...session,
    currentNode: match,
    firstTryCorrect: firstTry,
    requeueEntries: queue,
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

function settleIfLeaf(session: PracticeSession): PracticeSession {
  if (applicableChildren(session).length === 0) return backtrack(session);
  return session;
}

export function backtrack(session: PracticeSession): PracticeSession {
  if (session.phase === 'requeue') return session;

  const path = findPath(session.options.rootNode, session.currentNode.id);
  if (!path || path.length === 0) {
    return enterRequeueOrComplete(session);
  }
  const practiced = new Set(session.practicedChildIds);
  practiced.add(session.currentNode.id);
  for (let i = path.length - 2; i >= 0; i--) {
    const ancestor = path[i];
    const childById = new Map((ancestor.children ?? []).map((c) => [c.id, c]));
    const orderedIds = session.childOrderMap.get(ancestor.id) ?? (ancestor.children ?? []).map((c) => c.id);
    const candidates = orderedIds.flatMap((id) => {
      const c = childById.get(id);
      return c && !practiced.has(c.id) && isApplicableChild(session, ancestor, c) ? [c] : [];
    });
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
  return enterRequeueOrComplete({ ...session, practicedChildIds: practiced });
}

function enterRequeueOrComplete(session: PracticeSession): PracticeSession {
  if (session.requeueEntries.length === 0) {
    return { ...session, status: 'complete' };
  }
  const first = session.requeueEntries[0];
  const parent = findNodeById(session.options.rootNode, first.parentId);
  if (!parent) {
    return { ...session, status: 'complete' };
  }
  return {
    ...session,
    phase: 'requeue',
    currentNode: parent,
    hintLevel: 0,
    wrongAttemptsHere: 0,
    status: 'awaiting-user',
  };
}

function isApplicableChild(session: PracticeSession, parent: Node, child: Node): boolean {
  const userIsToMove = fenSide(parent.fen) === session.options.userColor;
  if (userIsToMove) {
    if (session.options.mode === 'learn') return (session.applicableCounts.get(child.id) ?? 0) > 0;
    const learnable = session.learnableMap.get(child.id) ?? false;
    if (learnable) return session.options.learnedNodeIds.has(child.id);
    return (session.applicableCounts.get(child.id) ?? 0) > 0;
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

function findNodeById(root: Node, id: string): Node | null {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const f = findNodeById(c, id);
    if (f) return f;
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
    visitedUserMoveIds: Array.from(session.firstTryCorrect),
  };
}
