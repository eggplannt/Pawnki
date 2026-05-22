import { getDb } from './db';
import { applySm2, addDays, todayYmd, type Quality, type CardState } from './sm2';
import { bumpStreak } from './streaks';
import type { Node, Opening, Review } from '../types';

// Review session ordering preference.
// - due-first: oldest due date first (default; mirrors Anki).
// - random:    fully shuffled.
// - interleave: shuffle by opening so the same opening's positions don't all
//   cluster together — keeps the session varied without losing due-priority.
export type ReviewOrder = 'due-first' | 'random' | 'interleave';
export const DEFAULT_REVIEW_ORDER: ReviewOrder = 'due-first';
export const REVIEW_ORDERS: ReviewOrder[] = ['due-first', 'random', 'interleave'];

// Note: the underlying table is named `review_cards` (legacy from initial
// schema). In code/UI we treat each row as a "review" of a position — not a
// flashcard. Don't rename the table; do prefer "review" / "position" in names.

/**
 * Return the set of node ids in this opening that the current user has already
 * learned (i.e. has a review row for).
 */
export async function getLearnedNodeIds(openingId: string): Promise<Set<string>> {
  const { data, error } = await getDb()
    .from('review_cards')
    .select('node_id, nodes!inner(opening_id)')
    .eq('nodes.opening_id', openingId);
  if (error) throw error;
  return new Set((data ?? []).map((r: any) => r.node_id));
}

/**
 * Return position_keys of all learned nodes belonging to openings other than
 * `excludeOpeningId`. Used to treat trunk transpositions as effectively learned
 * when the same position + unique response was already learned elsewhere.
 */
export async function getCrossOpeningLearnedPositionKeys(excludeOpeningId: string): Promise<Set<string>> {
  const { data, error } = await getDb()
    .from('review_cards')
    .select('nodes!inner(position_key, opening_id)');
  if (error) throw error;
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<{ nodes: { position_key: string; opening_id: string } | null }>) {
    if (r.nodes && r.nodes.opening_id !== excludeOpeningId && r.nodes.position_key) {
      out.add(r.nodes.position_key);
    }
  }
  return out;
}

/**
 * Return per-opening counts of learned positions for all openings the current
 * user owns. Map keyed by opening_id.
 */
export async function getLearnedCountsByOpening(): Promise<Map<string, number>> {
  const { data, error } = await getDb()
    .from('review_cards')
    .select('nodes!inner(opening_id)');
  if (error) throw error;
  const out = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ nodes: { opening_id: string } | null }>) {
    const oid = row.nodes?.opening_id;
    if (!oid) continue;
    out.set(oid, (out.get(oid) ?? 0) + 1);
  }
  return out;
}

/**
 * Mark the given node ids as learned by inserting review rows. Skips ids that
 * already have a row (returns the actually-inserted count). All SM-2 fields
 * fall back to DB defaults (interval=1, ef=2.5, repetitions=0, due_date=today)
 * so newly-learned positions are immediately due for review.
 */
export async function markPositionsLearned(nodeIds: string[]): Promise<number> {
  if (nodeIds.length === 0) return 0;
  const { data: { user } } = await getDb().auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const rows = nodeIds.map((id) => ({ node_id: id, user_id: user.id }));
  const { data, error } = await getDb()
    .from('review_cards')
    .upsert(rows, { onConflict: 'node_id,user_id', ignoreDuplicates: true })
    .select('id');
  if (error) throw error;
  return data?.length ?? 0;
}

// ── Phase 6: due reviews + grading ──────────────────────────────────────────

export interface ReviewItem {
  review: Review;
  node: Node;
  /** Parent node — its fen is the board position the user sees (with user to move). */
  parent: Node;
  opening: Pick<Opening, 'id' | 'name' | 'color'>;
  /** All valid SAN moves at the parent position (siblings sharing parent_id).
   *  Used to accept any-correct-answer at branching positions. */
  acceptedSans: string[];
  /** From-squares of the accepted moves (deduped). Used for hint highlighting. */
  acceptedFromSquares: string[];
}

/**
 * Fetch all reviews due on or before today, joined with their node, parent
 * node, and opening info. Reviews whose node has no parent (the opening root)
 * are skipped — there's no position to quiz from.
 */
export async function getDueReviews(order: ReviewOrder = DEFAULT_REVIEW_ORDER): Promise<ReviewItem[]> {
  const today = todayYmd();
  // Due iff: scheduled on/before today, OR never reviewed yet (a freshly-
  // learned position with no first review must always surface, regardless of
  // its due_date default).
  const { data, error } = await getDb()
    .from('review_cards')
    .select(`
      *,
      node:nodes!inner(*, opening:openings!inner(id, name, color))
    `)
    .or(`due_date.lte.${today},last_reviewed.is.null`)
    .order('last_reviewed', { ascending: true, nullsFirst: true })
    .order('due_date', { ascending: true });
  if (error) throw error;

  const items = (data ?? []) as Array<Review & { node: Node & { opening: Pick<Opening, 'id' | 'name' | 'color'> } }>;
  if (items.length === 0) return [];

  const parentIds = Array.from(new Set(items.map((r) => r.node.parent_id).filter((v): v is string => !!v)));
  if (parentIds.length === 0) return [];

  const [{ data: parents, error: pErr }, { data: siblings, error: sErr }] = await Promise.all([
    getDb().from('nodes').select('*').in('id', parentIds),
    getDb().from('nodes').select('id, move_san, move_uci, parent_id, opening_id').in('parent_id', parentIds),
  ]);
  if (pErr) throw pErr;
  if (sErr) throw sErr;

  const parentMap = new Map<string, Node>((parents ?? []).map((p) => [p.id, p as Node]));
  const sansByParent = new Map<string, string[]>();
  const fromSqByParent = new Map<string, Set<string>>();
  for (const s of (siblings ?? []) as Array<{ parent_id: string; move_san: string | null; move_uci: string | null }>) {
    if (!s.parent_id || !s.move_san) continue;
    const arr = sansByParent.get(s.parent_id) ?? [];
    arr.push(s.move_san);
    sansByParent.set(s.parent_id, arr);
    const from = s.move_uci?.slice(0, 2);
    if (from) {
      const set = fromSqByParent.get(s.parent_id) ?? new Set<string>();
      set.add(from);
      fromSqByParent.set(s.parent_id, set);
    }
  }

  const out: ReviewItem[] = [];
  for (const row of items) {
    const parent = row.node.parent_id ? parentMap.get(row.node.parent_id) : null;
    if (!parent) continue;
    const { opening, ...nodeRest } = row.node;
    const { node: _drop, ...reviewRest } = row as any;
    out.push({
      review: reviewRest as Review,
      node: nodeRest as Node,
      parent,
      opening,
      acceptedSans: sansByParent.get(parent.id) ?? [nodeRest.move_san!].filter(Boolean),
      acceptedFromSquares: Array.from(
        fromSqByParent.get(parent.id) ?? new Set<string>([nodeRest.move_uci?.slice(0, 2)].filter(Boolean) as string[]),
      ),
    });
  }

  if (order === 'random') {
    return shuffle(out);
  }
  if (order === 'interleave') {
    return interleaveByOpening(out);
  }
  return out;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Round-robin items across openings so the same opening doesn't streak. */
function interleaveByOpening(items: ReviewItem[]): ReviewItem[] {
  const buckets = new Map<string, ReviewItem[]>();
  for (const it of items) {
    const k = it.opening.id;
    const arr = buckets.get(k) ?? [];
    arr.push(it);
    buckets.set(k, arr);
  }
  const queues = Array.from(buckets.values());
  const out: ReviewItem[] = [];
  while (queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/**
 * Apply SM-2 to a review given the user's grade and persist the new state.
 */
export async function gradeReview(
  review: Review,
  quality: Quality,
): Promise<{ next: ReturnType<typeof applySm2>; dueDate: string }> {
  const prev: CardState = {
    interval: review.interval,
    ease_factor: review.ease_factor,
    repetitions: review.repetitions,
  };
  const next = applySm2(prev, quality);
  const dueDate = addDays(todayYmd(), next.interval);
  const { error } = await getDb()
    .from('review_cards')
    .update({
      interval: next.interval,
      ease_factor: next.ease_factor,
      repetitions: next.repetitions,
      due_date: dueDate,
      last_reviewed: new Date().toISOString(),
    })
    .eq('id', review.id);
  if (error) throw error;
  // Best-effort streak bump — don't fail the grade if this errors.
  try { await bumpStreak(); } catch { /* ignore */ }
  return { next, dueDate };
}

export interface ReviewStats {
  dueToday: number;
  totalLearned: number;
  /** % of positions with repetitions >= 2 among those reviewed at least once.
   *  Rough proxy for retention. */
  retention: number | null;
}

/**
 * Delete all review_cards rows for nodes belonging to the given opening,
 * resetting the opening to "unlearned" state.
 */
export async function unlearnPositionsForOpening(openingId: string): Promise<void> {
  const { data: nodes, error: nErr } = await getDb()
    .from('nodes')
    .select('id')
    .eq('opening_id', openingId);
  if (nErr) throw nErr;
  if (!nodes || nodes.length === 0) return;
  const nodeIds = (nodes as Array<{ id: string }>).map((n) => n.id);
  const { error } = await getDb()
    .from('review_cards')
    .delete()
    .in('node_id', nodeIds);
  if (error) throw error;
}

/**
 * Delete review_cards rows for specific node ids. No-op for ids that have no
 * row. Used to auto-unlearn positions that are no longer uniquely learnable
 * (e.g. when a second correct solution is added at a branching point).
 */
export async function unlearnNodeIds(nodeIds: string[]): Promise<void> {
  if (nodeIds.length === 0) return;
  const { error } = await getDb()
    .from('review_cards')
    .delete()
    .in('node_id', nodeIds);
  if (error) throw error;
}

export async function getReviewStats(): Promise<ReviewStats> {
  const today = todayYmd();
  const db = getDb();
  const [dueRes, totalRes, reviewedRes, retainedRes] = await Promise.all([
    db.from('review_cards').select('id', { count: 'exact', head: true }).or(`due_date.lte.${today},last_reviewed.is.null`),
    db.from('review_cards').select('id', { count: 'exact', head: true }),
    db.from('review_cards').select('id', { count: 'exact', head: true }).not('last_reviewed', 'is', null),
    db.from('review_cards').select('id', { count: 'exact', head: true }).gte('repetitions', 2),
  ]);
  if (dueRes.error) throw dueRes.error;
  if (totalRes.error) throw totalRes.error;
  if (reviewedRes.error) throw reviewedRes.error;
  if (retainedRes.error) throw retainedRes.error;

  const reviewed = reviewedRes.count ?? 0;
  const retained = retainedRes.count ?? 0;
  return {
    dueToday: dueRes.count ?? 0,
    totalLearned: totalRes.count ?? 0,
    retention: reviewed > 0 ? Math.round((retained / reviewed) * 100) : null,
  };
}
