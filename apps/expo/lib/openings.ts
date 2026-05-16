import { supabase } from './supabase';
import { parsePgn, type PgnNode } from './pgn-tree';
import type { Opening, Node } from '@/types';

// ── Openings ────────────────────────────────────────────────────────────────

export async function listOpenings() {
  const { data, error } = await supabase
    .from('openings')
    .select('*, nodes(count)')
    .order('created_at', { ascending: false });

  if (error) throw error;

  return (data ?? []).map((o) => {
    const nodeCount = (o.nodes as any)?.[0]?.count ?? 0;
    return { ...o, nodeCount, dueCount: 0 } as Opening & {
      nodeCount: number;
      dueCount: number;
    };
  });
}

export interface ImportProgress {
  phase: 'parsing' | 'importing';
  current: number;
  total: number;
}

export async function createOpening(
  name: string,
  color: 'white' | 'black',
  pgn: string | null,
  onProgress?: (p: ImportProgress) => void,
) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: opening, error } = await supabase
    .from('openings')
    .insert({ name, color, user_id: user.id })
    .select()
    .single();

  if (error) throw error;

  if (pgn && pgn.trim()) {
    await importPgnToOpening(opening.id, pgn, onProgress);
  } else {
    await supabase.from('nodes').insert({
      opening_id: opening.id,
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      sort_order: 0,
    });
  }

  return opening as Opening;
}

export async function deleteOpening(id: string) {
  const { error } = await supabase.from('openings').delete().eq('id', id);
  if (error) throw error;
}

// ── Nodes ───────────────────────────────────────────────────────────────────

export async function getNodes(openingId: string): Promise<Node[]> {
  const { data, error } = await supabase
    .from('nodes')
    .select('*')
    .eq('opening_id', openingId)
    .order('sort_order', { ascending: true });

  if (error) throw error;
  return data as Node[];
}

export function buildTree(nodes: Node[]): Node | null {
  if (nodes.length === 0) return null;

  const map = new Map<string, Node>();
  for (const n of nodes) {
    map.set(n.id, { ...n, children: [] });
  }

  let root: Node | null = null;
  for (const n of nodes) {
    const node = map.get(n.id)!;
    if (n.parent_id && map.has(n.parent_id)) {
      map.get(n.parent_id)!.children!.push(node);
    } else {
      root = node;
    }
  }

  return root;
}

// ── Node CRUD ──────────────────────────────────────────────────────────────

export async function createNode(
  openingId: string,
  parentId: string,
  moveSan: string,
  moveUci: string,
  fen: string,
  annotation?: string | null,
): Promise<Node> {
  const { data: maxRow } = await supabase
    .from('nodes')
    .select('sort_order')
    .eq('opening_id', openingId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .single();

  const sortOrder = (maxRow?.sort_order ?? 0) + 1;

  const { data, error } = await supabase
    .from('nodes')
    .insert({
      opening_id: openingId,
      parent_id: parentId,
      move_san: moveSan,
      move_uci: moveUci,
      fen,
      annotation: annotation ?? null,
      sort_order: sortOrder,
    })
    .select()
    .single();

  if (error) throw error;
  return data as Node;
}

export async function deleteSubtree(nodeId: string, openingId: string) {
  const allNodes = await getNodes(openingId);
  const idsToDelete = new Set<string>();

  function collectIds(id: string) {
    idsToDelete.add(id);
    for (const n of allNodes) {
      if (n.parent_id === id) collectIds(n.id);
    }
  }
  collectIds(nodeId);

  const { error } = await supabase
    .from('nodes')
    .delete()
    .in('id', [...idsToDelete]);

  if (error) throw error;
}

export async function updateNodeAnnotation(nodeId: string, annotation: string | null) {
  const { error } = await supabase
    .from('nodes')
    .update({ annotation })
    .eq('id', nodeId);

  if (error) throw error;
}

/**
 * Check if a FEN exists in another opening, but only if the parent FEN
 * does NOT also exist in that same opening (i.e. this is the first point
 * of convergence, not a common shared trunk position).
 */
export async function findTransposition(
  fen: string,
  parentFen: string,
  excludeOpeningId: string,
): Promise<{ openingName: string; openingId: string } | null> {
  const { data, error } = await supabase
    .from('nodes')
    .select('id, opening_id, openings(id, name)')
    .eq('fen', fen)
    .neq('opening_id', excludeOpeningId)
    .limit(5);

  if (error || !data || data.length === 0) return null;

  for (const row of data) {
    const otherOpeningId = row.opening_id;
    const { data: parentMatch } = await supabase
      .from('nodes')
      .select('id')
      .eq('fen', parentFen)
      .eq('opening_id', otherOpeningId)
      .limit(1);

    if (!parentMatch || parentMatch.length === 0) {
      const opening = (row as any).openings;
      if (opening) return { openingName: opening.name, openingId: opening.id };
    }
  }

  return null;
}

/**
 * Check if a FEN already exists elsewhere in the same opening
 * (reached via a different move order).
 */
export async function findIntraOpeningTransposition(
  fen: string,
  openingId: string,
  excludeParentId: string,
): Promise<{ nodeId: string; moveSan: string | null } | null> {
  const { data, error } = await supabase
    .from('nodes')
    .select('id, move_san, parent_id')
    .eq('fen', fen)
    .eq('opening_id', openingId)
    .limit(5);

  if (error || !data) return null;

  const match = data.find((n) => n.parent_id !== excludeParentId);
  if (!match) return null;

  return { nodeId: match.id, moveSan: match.move_san };
}

// ── PGN Import ──────────────────────────────────────────────────────────────

/**
 * Import PGN into an opening, merging with existing nodes.
 * If the opening already has a tree, new moves are merged in —
 * existing positions are reused, only new branches are inserted.
 * If the opening is empty, a fresh tree is created.
 */
export async function importPgnToOpening(
  openingId: string,
  pgn: string,
  onProgress?: (p: ImportProgress) => void,
) {
  onProgress?.({ phase: 'parsing', current: 0, total: 0 });
  const pgnTree = parsePgn(pgn);

  let totalNew = 0;
  function countNodes(node: PgnNode) { totalNew++; for (const c of node.children) countNodes(c); }
  countNodes(pgnTree);

  const existingNodes = await getNodes(openingId);
  const existingTree = buildTree(existingNodes);

  const childByFen = new Map<string, Map<string, Node>>();
  function indexExisting(node: Node) {
    const childMap = new Map<string, Node>();
    for (const child of node.children ?? []) {
      childMap.set(child.fen, child);
      indexExisting(child);
    }
    childByFen.set(node.id, childMap);
  }

  let rootDbId: string;

  if (existingTree) {
    indexExisting(existingTree);
    rootDbId = existingTree.id;
  } else {
    const { data: maxRow } = await supabase
      .from('nodes')
      .select('sort_order')
      .eq('opening_id', openingId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .single();
    const sortOrder = (maxRow?.sort_order ?? -1) + 1;

    const { data: rootRow, error: rootErr } = await supabase
      .from('nodes')
      .insert({
        opening_id: openingId,
        fen: pgnTree.fen,
        move_san: pgnTree.move_san,
        move_uci: pgnTree.move_uci,
        annotation: pgnTree.annotation,
        sort_order: sortOrder,
      })
      .select()
      .single();

    if (rootErr) throw rootErr;
    rootDbId = rootRow.id;
    childByFen.set(rootDbId, new Map());
  }

  let inserted = 0;
  onProgress?.({ phase: 'importing', current: 0, total: totalNew });

  async function walkAndMerge(pgnNode: PgnNode, parentDbId: string) {
    for (const pgnChild of pgnNode.children) {
      const parentChildren = childByFen.get(parentDbId);
      const existingChild = parentChildren?.get(pgnChild.fen);

      if (existingChild) {
        inserted++;
        onProgress?.({ phase: 'importing', current: inserted, total: totalNew });
        await walkAndMerge(pgnChild, existingChild.id);
      } else {
        await insertSubtree(pgnChild, parentDbId, openingId);
      }
    }
  }

  async function insertSubtree(pgnNode: PgnNode, parentDbId: string, opId: string) {
    const { data: maxRow } = await supabase
      .from('nodes')
      .select('sort_order')
      .eq('opening_id', opId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .single();
    const sortOrder = (maxRow?.sort_order ?? -1) + 1;

    const { data: row, error } = await supabase
      .from('nodes')
      .insert({
        opening_id: opId,
        parent_id: parentDbId,
        fen: pgnNode.fen,
        move_san: pgnNode.move_san,
        move_uci: pgnNode.move_uci,
        annotation: pgnNode.annotation,
        sort_order: sortOrder,
      })
      .select()
      .single();

    if (error) throw error;

    inserted++;
    onProgress?.({ phase: 'importing', current: inserted, total: totalNew });

    for (const child of pgnNode.children) {
      await insertSubtree(child, row.id, opId);
    }
  }

  await walkAndMerge(pgnTree, rootDbId);
}
