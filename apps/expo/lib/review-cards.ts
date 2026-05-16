import { supabase } from './supabase';

/**
 * Return the set of node ids in this opening that already have a
 * review_cards row for the current user (i.e. are "learned").
 */
export async function getLearnedNodeIds(openingId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('review_cards')
    .select('node_id, nodes!inner(opening_id)')
    .eq('nodes.opening_id', openingId);
  if (error) throw error;
  return new Set((data ?? []).map((r: any) => r.node_id));
}

/**
 * Return per-opening counts of learned (i.e. having a review_cards row)
 * nodes for all openings the current user owns. Map keyed by opening_id.
 */
export async function getLearnedCountsByOpening(): Promise<Map<string, number>> {
  const { data, error } = await supabase
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
 * Insert review_cards rows for the given node ids. Skips ids that already
 * have a row (returns the actually-inserted count). All SM-2 fields are left
 * to DB defaults (interval=0, ef=2.5, repetitions=0, due_date=today).
 */
export async function insertReviewCards(nodeIds: string[]): Promise<number> {
  if (nodeIds.length === 0) return 0;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const rows = nodeIds.map((id) => ({ node_id: id, user_id: user.id }));
  // onConflict: do nothing — node_id is unique per user via RLS+constraint;
  // if a row exists, leave it untouched (Phase 5 never mutates existing cards).
  const { data, error } = await supabase
    .from('review_cards')
    .upsert(rows, { onConflict: 'node_id,user_id', ignoreDuplicates: true })
    .select('id');
  if (error) throw error;
  return data?.length ?? 0;
}
