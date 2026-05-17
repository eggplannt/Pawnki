import { supabase } from './supabase';
import { parsePgn, positionKey, type PgnNode } from './pgn-tree';
import { computeLearnableMap } from './practice';

export { positionKey } from './pgn-tree';
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

export async function getOpening(id: string) {
  const { data, error } = await supabase
    .from('openings')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw error;
  return data as Opening;
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

  if (error) {
    if (error.code === '23505') {
      throw new Error(`You already have a ${color} opening named "${name}".`);
    }
    throw error;
  }

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

export async function updateOpening(
  id: string,
  updates: { name?: string; description?: string | null },
) {
  const { data, error } = await supabase
    .from('openings')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as Opening;
}

export async function deleteOpening(id: string) {
  const { error } = await supabase.from('openings').delete().eq('id', id);
  if (error) throw error;
}

// ── Nodes ───────────────────────────────────────────────────────────────────

export async function getLearnableCountsByOpening(): Promise<Map<string, number>> {
  const [openingsRes, nodesRes] = await Promise.all([
    supabase.from('openings').select('id, color'),
    supabase.from('nodes').select('*').order('sort_order', { ascending: true }),
  ]);
  if (openingsRes.error) throw openingsRes.error;
  if (nodesRes.error) throw nodesRes.error;

  const byOpening = new Map<string, Node[]>();
  for (const n of (nodesRes.data ?? []) as Node[]) {
    const arr = byOpening.get(n.opening_id);
    if (arr) arr.push(n);
    else byOpening.set(n.opening_id, [n]);
  }

  const out = new Map<string, number>();
  for (const op of openingsRes.data ?? []) {
    const tree = buildTree(byOpening.get(op.id) ?? []);
    if (!tree) { out.set(op.id, 0); continue; }
    const lm = computeLearnableMap(tree, op.color as 'white' | 'black');
    let total = 0;
    for (const [, v] of lm) if (v) total++;
    out.set(op.id, total);
  }
  return out;
}

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

export class CrossLinkDeleteError extends Error {
  blockingOpenings: string[];
  constructor(openings: string[]) {
    super(
      openings.length === 1
        ? `"${openings[0]}" links to a position in this branch. Unlink or absorb it first.`
        : `${openings.length} other openings link to positions in this branch. Unlink or absorb them first.`,
    );
    this.name = 'CrossLinkDeleteError';
    this.blockingOpenings = openings;
  }
}

export async function deleteSubtree(nodeId: string, openingId: string) {
  const allNodes = await getNodes(openingId);
  const subtreeIds = new Set<string>();
  function collectIds(id: string) {
    subtreeIds.add(id);
    for (const n of allNodes) {
      if (n.parent_id === id) collectIds(n.id);
    }
  }
  collectIds(nodeId);

  const { data: linkRows } = await supabase
    .from('nodes')
    .select('id, opening_id, sort_order, transposes_to_node_id, openings(name)')
    .in('transposes_to_node_id', [...subtreeIds]);

  const crossLinks = (linkRows ?? []).filter((r) => r.opening_id !== openingId);
  if (crossLinks.length > 0) {
    const names = Array.from(new Set(crossLinks.map((r) => (r as any).openings?.name).filter(Boolean)));
    throw new CrossLinkDeleteError(names);
  }

  const intraLinks = (linkRows ?? []).filter((r) => r.opening_id === openingId);
  const intraToRoot = intraLinks
    .filter((r) => r.transposes_to_node_id === nodeId)
    .sort((a, b) => a.sort_order - b.sort_order);
  const intraToNonRoot = intraLinks.filter((r) => r.transposes_to_node_id !== nodeId);

  if (intraToNonRoot.length > 0) {
    throw new Error(
      'This branch contains nodes that other moves in this opening link to. Re-route those links first.',
    );
  }

  if (intraToRoot.length > 0) {
    const promoted = intraToRoot[0];
    await makeCanonical(openingId, promoted.id, nodeId);
    const { error } = await supabase.from('nodes').delete().eq('id', nodeId);
    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from('nodes')
    .delete()
    .in('id', [...subtreeIds]);
  if (error) throw error;
}

export async function updateNodeAnnotation(nodeId: string, annotation: string | null) {
  const { error } = await supabase
    .from('nodes')
    .update({ annotation })
    .eq('id', nodeId);

  if (error) throw error;
}

function resolveCanonicalId(node: Pick<Node, 'id' | 'transposes_to_node_id'>, all: Map<string, Node>): string {
  let cur: Pick<Node, 'id' | 'transposes_to_node_id'> | undefined = node;
  const seen = new Set<string>();
  while (cur && cur.transposes_to_node_id && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = all.get(cur.transposes_to_node_id);
  }
  return cur?.id ?? node.id;
}

export interface CrossTranspositionMatch {
  canonicalNodeId: string;
  openingId: string;
  openingName: string;
  openingColor: 'white' | 'black';
}

export interface IntraTranspositionMatch {
  canonicalNodeId: string;
  moveSan: string | null;
}

export async function findTransposition(
  fen: string,
  parentFen: string,
  excludeOpeningId: string,
): Promise<CrossTranspositionMatch | null> {
  const key = positionKey(fen);
  const parentKey = positionKey(parentFen);

  const { data, error } = await supabase
    .from('nodes')
    .select('id, opening_id, transposes_to_node_id, openings(id, name, color)')
    .eq('position_key', key)
    .neq('opening_id', excludeOpeningId)
    .limit(10);

  if (error || !data || data.length === 0) return null;

  for (const row of data) {
    const otherOpeningId = row.opening_id;
    const { data: parentMatch } = await supabase
      .from('nodes')
      .select('id')
      .eq('position_key', parentKey)
      .eq('opening_id', otherOpeningId)
      .limit(1);

    if (parentMatch && parentMatch.length > 0) continue;

    const opening = (row as any).openings;
    if (!opening) continue;

    let canonicalId = row.id as string;
    if (row.transposes_to_node_id) {
      const { data: targetRow } = await supabase
        .from('nodes')
        .select('id')
        .eq('id', row.transposes_to_node_id)
        .single();
      if (targetRow) canonicalId = targetRow.id;
    }

    return {
      canonicalNodeId: canonicalId,
      openingId: opening.id,
      openingName: opening.name,
      openingColor: opening.color,
    };
  }

  return null;
}

export async function findIntraOpeningTransposition(
  fen: string,
  openingId: string,
  excludeNodeId: string,
): Promise<IntraTranspositionMatch | null> {
  const { data, error } = await supabase
    .from('nodes')
    .select('id, move_san, parent_id, transposes_to_node_id')
    .eq('position_key', positionKey(fen))
    .eq('opening_id', openingId);

  if (error || !data) return null;

  const lookup = new Map<string, Node>();
  for (const n of data) lookup.set(n.id, n as Node);

  const candidates = data.filter((n) => n.id !== excludeNodeId);
  if (candidates.length === 0) return null;

  const canonical = candidates.find((n) => !n.transposes_to_node_id);
  const pick = canonical ?? candidates[0];
  const canonicalId = resolveCanonicalId(pick, lookup);

  return { canonicalNodeId: canonicalId, moveSan: pick.move_san };
}

export async function getTranspositionTargets(
  targetIds: string[],
): Promise<Map<string, { node: Node; openingId: string; openingName: string; openingColor: 'white' | 'black' }>> {
  const out = new Map<string, { node: Node; openingId: string; openingName: string; openingColor: 'white' | 'black' }>();
  if (targetIds.length === 0) return out;

  const { data, error } = await supabase
    .from('nodes')
    .select('*, openings(id, name, color)')
    .in('id', targetIds);
  if (error || !data) return out;

  for (const row of data) {
    const opening = (row as any).openings;
    if (!opening) continue;
    out.set(row.id, {
      node: row as Node,
      openingId: opening.id,
      openingName: opening.name,
      openingColor: opening.color,
    });
  }
  return out;
}

/**
 * Return the id of the lowest-sort_order child of `parentId`, or null if it
 * has no children. Used when following a transposition link so the board
 * actually advances past the (same-position) canonical node.
 */
export async function getFirstChildId(parentId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('nodes')
    .select('id')
    .eq('parent_id', parentId)
    .order('sort_order', { ascending: true })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0].id;
}

export async function linkNode(linkNodeId: string, canonicalNodeId: string) {
  const { error } = await supabase
    .from('nodes')
    .update({ transposes_to_node_id: canonicalNodeId })
    .eq('id', linkNodeId);
  if (error) throw error;
}

export async function unlinkNode(linkNodeId: string) {
  const { error } = await supabase
    .from('nodes')
    .update({ transposes_to_node_id: null })
    .eq('id', linkNodeId);
  if (error) throw error;
}

export async function unlinkAndPromote(
  nodeId: string,
  openingId: string,
  positionKeyValue: string,
) {
  await unlinkNode(nodeId);

  const { data: duplicates, error } = await supabase
    .from('nodes')
    .select('id')
    .eq('opening_id', openingId)
    .eq('position_key', positionKeyValue)
    .neq('id', nodeId);
  if (error) throw error;

  const dupIds = (duplicates ?? []).map((r) => r.id);
  if (dupIds.length === 0) return;

  const { error: repointErr } = await supabase
    .from('nodes')
    .update({ transposes_to_node_id: nodeId })
    .in('id', dupIds);
  if (repointErr) throw repointErr;
}

export async function absorbCrossCanonical(
  newCanonicalId: string,
  oldCanonicalId: string,
  newOpeningId: string,
) {
  const allDescendantIds: string[] = [];
  let frontier = [oldCanonicalId];
  while (frontier.length > 0) {
    const { data, error } = await supabase
      .from('nodes')
      .select('id')
      .in('parent_id', frontier);
    if (error) throw error;
    const ids = (data ?? []).map((r) => r.id);
    if (ids.length === 0) break;
    allDescendantIds.push(...ids);
    frontier = ids;
  }

  if (allDescendantIds.length > 0) {
    const { error: oidErr } = await supabase
      .from('nodes')
      .update({ opening_id: newOpeningId })
      .in('id', allDescendantIds);
    if (oidErr) throw oidErr;
  }

  const { data: directChildren, error: childErr } = await supabase
    .from('nodes')
    .select('id')
    .eq('parent_id', oldCanonicalId);
  if (childErr) throw childErr;
  if (directChildren && directChildren.length > 0) {
    const { error: reparentErr } = await supabase
      .from('nodes')
      .update({ parent_id: newCanonicalId })
      .in('id', directChildren.map((r) => r.id));
    if (reparentErr) throw reparentErr;
  }

  const { error: repointErr } = await supabase
    .from('nodes')
    .update({ transposes_to_node_id: newCanonicalId })
    .eq('transposes_to_node_id', oldCanonicalId);
  if (repointErr) throw repointErr;

  await linkNode(oldCanonicalId, newCanonicalId);
}

export async function makeCanonical(
  _openingId: string,
  newCanonicalId: string,
  oldCanonicalId: string,
) {
  const { data: childRows, error: childErr } = await supabase
    .from('nodes')
    .select('id')
    .eq('parent_id', oldCanonicalId);
  if (childErr) throw childErr;

  if (childRows && childRows.length > 0) {
    const ids = childRows.map((r) => r.id);
    const { error: reparentErr } = await supabase
      .from('nodes')
      .update({ parent_id: newCanonicalId })
      .in('id', ids);
    if (reparentErr) throw reparentErr;
  }

  const { error: repointErr } = await supabase
    .from('nodes')
    .update({ transposes_to_node_id: newCanonicalId })
    .eq('transposes_to_node_id', oldCanonicalId);
  if (repointErr) throw repointErr;

  await linkNode(oldCanonicalId, newCanonicalId);
}

// ── PGN Import ──────────────────────────────────────────────────────────────

export interface ImportOptions {
  autoLinkTranspositions?: boolean;
}

export interface ImportResult {
  transpositionLinks: { linkNodeId: string; canonicalNodeId: string }[];
}

export async function importPgnToOpening(
  openingId: string,
  pgn: string,
  onProgress?: (p: ImportProgress) => void,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const autoLink = options.autoLinkTranspositions ?? true;
  const transpositionLinks: { linkNodeId: string; canonicalNodeId: string }[] = [];

  onProgress?.({ phase: 'parsing', current: 0, total: 0 });
  const pgnTree = parsePgn(pgn);

  let totalNew = 0;
  function countNodes(node: PgnNode) { totalNew++; for (const c of node.children) countNodes(c); }
  countNodes(pgnTree);

  const existingNodes = await getNodes(openingId);
  const existingTree = buildTree(existingNodes);

  const childByFen = new Map<string, Map<string, Node>>();
  const globalByKey = new Map<string, string>();

  function rememberCanonical(id: string, posKey: string, linkTarget: string | null) {
    if (linkTarget) {
      globalByKey.set(posKey, linkTarget);
    } else if (!globalByKey.has(posKey)) {
      globalByKey.set(posKey, id);
    }
  }

  function indexExisting(node: Node) {
    rememberCanonical(node.id, node.position_key, node.transposes_to_node_id);
    const childMap = new Map<string, Node>();
    for (const child of node.children ?? []) {
      childMap.set(child.position_key, child);
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
      .select('*')
      .single();

    if (rootErr) throw rootErr;
    rootDbId = rootRow.id;
    childByFen.set(rootDbId, new Map());
    rememberCanonical(rootRow.id, rootRow.position_key, null);
  }

  let inserted = 0;
  onProgress?.({ phase: 'importing', current: 0, total: totalNew });

  async function insertOne(
    pgnNode: PgnNode,
    parentDbId: string,
    linkTo: string | null,
  ): Promise<{ id: string; isLink: boolean; posKey: string }> {
    const { data: maxRow } = await supabase
      .from('nodes')
      .select('sort_order')
      .eq('opening_id', openingId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .single();
    const sortOrder = (maxRow?.sort_order ?? -1) + 1;

    const { data: row, error } = await supabase
      .from('nodes')
      .insert({
        opening_id: openingId,
        parent_id: parentDbId,
        fen: pgnNode.fen,
        move_san: pgnNode.move_san,
        move_uci: pgnNode.move_uci,
        annotation: pgnNode.annotation,
        sort_order: sortOrder,
        transposes_to_node_id: linkTo,
      })
      .select('*')
      .single();
    if (error) throw error;

    inserted++;
    onProgress?.({ phase: 'importing', current: inserted, total: totalNew });

    const parentMap = childByFen.get(parentDbId);
    if (parentMap) parentMap.set(row.position_key, row as Node);
    childByFen.set(row.id, new Map());
    rememberCanonical(row.id, row.position_key, row.transposes_to_node_id);

    return { id: row.id, isLink: !!linkTo, posKey: row.position_key };
  }

  async function insertSubtree(pgnNode: PgnNode, parentDbId: string) {
    const posKey = positionKey(pgnNode.fen);
    const existingCanonical = globalByKey.get(posKey);

    if (existingCanonical) {
      const result = await insertOne(pgnNode, parentDbId, existingCanonical);
      if (!autoLink) {
        transpositionLinks.push({ linkNodeId: result.id, canonicalNodeId: existingCanonical });
      }
      return;
    }

    const created = await insertOne(pgnNode, parentDbId, null);
    for (const child of pgnNode.children) {
      await insertSubtreeOrMerge(child, created.id);
    }
  }

  async function insertSubtreeOrMerge(pgnNode: PgnNode, parentDbId: string) {
    const parentChildren = childByFen.get(parentDbId);
    const existingChild = parentChildren?.get(positionKey(pgnNode.fen));
    if (existingChild) {
      inserted++;
      onProgress?.({ phase: 'importing', current: inserted, total: totalNew });
      for (const child of pgnNode.children) {
        await insertSubtreeOrMerge(child, existingChild.id);
      }
      return;
    }
    await insertSubtree(pgnNode, parentDbId);
  }

  for (const pgnChild of pgnTree.children) {
    await insertSubtreeOrMerge(pgnChild, rootDbId);
  }

  return { transpositionLinks };
}
