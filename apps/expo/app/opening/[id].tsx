import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  InteractionManager,
  Modal,
  TextInput,
  ScrollView,
  Switch,
  useWindowDimensions,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  getOpening,
  getNodes, buildTree,
  createNode, deleteSubtree, updateNodeAnnotation,
  findTransposition, findIntraOpeningTransposition,
  importPgnToOpening,
  linkNode, unlinkAndPromote, makeCanonical, absorbCrossCanonical,
  getTranspositionTargets, getFirstChildId, positionKey,
  type ImportProgress,
  type CrossTranspositionMatch,
  type IntraTranspositionMatch,
  IntraLinkConflict,
  getLearnedNodeIds,
  getCrossOpeningLearnedPositionKeys,
  computeApplicableCounts,
  computeLearnableMap,
  augmentLearnedWithTranspositions,
  type Opening,
  type Node,
} from '@pawntree/shared';
import { useNavHistory } from '@/hooks/useNavHistory';
import { Chessboard, type ChessboardMove } from '@/components/Chessboard';
import { MoveList } from '@/components/MoveList';
import { useColorTheme } from '@/hooks/useColorTheme';

// ── Helpers ─────────────────────────────────────────────────────────────────

function fenInfo(fen: string) {
  const parts = fen.split(' ');
  return { isWhite: parts[1] === 'w', moveNum: parseInt(parts[5] ?? '1', 10) };
}

function movePrefix(node: Node, forceNumber: boolean): string {
  const { moveNum, isWhite } = fenInfo(node.fen);
  if (isWhite) return forceNumber ? `${moveNum - 1}...` : '';
  return `${moveNum}.`;
}

function moveSanWithNumber(node: Node): string {
  if (!node.move_san) return '(start)';
  const { moveNum, isWhite } = fenInfo(node.fen);
  return isWhite
    ? `${moveNum - 1}... ${node.move_san}`
    : `${moveNum}. ${node.move_san}`;
}

// Returns only the moves at branching points plus the final node — compact path
// signature that skips forced intermediate moves.
function keyPathMoves(path: Node[]): Node[] {
  const moves = path.slice(1);
  return moves.filter((_, i) => {
    const parent = path[i];
    return (parent.children?.length ?? 0) > 1 || i === moves.length - 1;
  });
}

function getPathNodes(node: Node, parentMap: Map<string, Node>): Node[] {
  const path: Node[] = [];
  let cur: Node | undefined = node;
  while (cur) {
    path.unshift(cur);
    cur = parentMap.get(cur.id);
  }
  return path;
}

type PathDiff = { src: Node[]; tgt: Node[] };

function computePathDiff(
  srcNode: Node,
  tgtNode: Node,
  parentMap: Map<string, Node>,
  nodeMap: Map<string, Node>,
): PathDiff | null {
  const tgtFull = nodeMap.get(tgtNode.id) ?? tgtNode;
  const srcPath = getPathNodes(srcNode, parentMap);
  const tgtPath = getPathNodes(tgtFull, parentMap);
  if (srcPath.length < 2 || tgtPath.length < 2) return null;

  const srcDecisions = new Map<string, Node>();
  const tgtDecisions = new Map<string, Node>();
  for (let i = 0; i + 1 < srcPath.length; i++) {
    const p = srcPath[i];
    if ((p.children?.length ?? 0) > 1) srcDecisions.set(p.id, srcPath[i + 1]);
  }
  for (let i = 0; i + 1 < tgtPath.length; i++) {
    const p = tgtPath[i];
    if ((p.children?.length ?? 0) > 1) tgtDecisions.set(p.id, tgtPath[i + 1]);
  }

  const srcDiff: Node[] = [];
  const tgtDiff: Node[] = [];
  for (const [pid, sTaken] of srcDecisions) {
    const tTaken = tgtDecisions.get(pid);
    if (tTaken && tTaken.id !== sTaken.id) {
      srcDiff.push(sTaken);
      tgtDiff.push(tTaken);
    }
  }
  if (srcDiff.length === 0) return null;

  const ply = (n: Node) => {
    const { moveNum, isWhite } = fenInfo(n.fen);
    return isWhite ? 2 * moveNum - 2 : 2 * moveNum - 1;
  };
  return {
    src: srcDiff.sort((a, b) => ply(a) - ply(b)),
    tgt: tgtDiff.sort((a, b) => ply(a) - ply(b)),
  };
}

function buildParentMap(root: Node): Map<string, Node> {
  const map = new Map<string, Node>();
  function walk(node: Node) {
    for (const child of node.children ?? []) {
      map.set(child.id, node);
      walk(child);
    }
  }
  walk(root);
  return map;
}

function findNodeById(root: Node, id: string): Node | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return null;
}

interface LinkEntry {
  node: Node;
  targetId: string;
}

function collectLinks(root: Node): LinkEntry[] {
  const out: LinkEntry[] = [];
  function walk(n: Node) {
    if (n.transposes_to_node_id) out.push({ node: n, targetId: n.transposes_to_node_id });
    for (const c of n.children ?? []) walk(c);
  }
  walk(root);
  return out;
}

type TargetInfo = { node: Node; openingId: string; openingName: string; openingColor: 'white' | 'black' };

type TransChoice = {
  newNodeId: string;
  newNodeFen: string;
  parentId: string;
  intra: IntraTranspositionMatch | null;
  cross: CrossTranspositionMatch | null;
  isReprompt: boolean;
};

// ── Main Component ──────────────────────────────────────────────────────────

export default function OpeningDetailScreen() {
  const { colors: colorTheme } = useColorTheme();
  const params = useLocalSearchParams<{ id: string; name?: string; color?: string; node?: string; from?: string }>();
  const id = params.id;
  const router = useRouter();
  const { width: screenWidth } = useWindowDimensions();
  const navHistory = useNavHistory();

  const [opening, setOpening] = useState<Opening>(() => ({
    id,
    user_id: '',
    name: params.name ?? 'Opening',
    color: (params.color as 'white' | 'black') ?? 'white',
    description: null,
    created_at: '',
  }));

  const [tree, setTree] = useState<Node | null>(null);
  const [currentNode, setCurrentNode] = useState<Node | null>(null);
  const [forwardStack, setForwardStack] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [treeReady, setTreeReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingFen, setPendingFen] = useState<string | null>(null);

  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState('');

  const [pgnOpen, setPgnOpen] = useState(false);
  const [pgnText, setPgnText] = useState('');
  const [autoLinkPgn, setAutoLinkPgn] = useState(true);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importTranspositionCount, setImportTranspositionCount] = useState<number | null>(null);

  const [transChoice, setTransChoice] = useState<TransChoice | null>(null);
  const [confirmCanonical, setConfirmCanonical] = useState<TransChoice | null>(null);
  const [transTargets, setTransTargets] = useState<Map<string, TargetInfo>>(new Map());
  const [panelMode, setPanelMode] = useState<'moves' | 'links'>('moves');
  const [crossSwitch, setCrossSwitch] = useState<{ targetInfo: TargetInfo; fromNodeId: string } | null>(null);
  const [currentHasTrans, setCurrentHasTrans] = useState(false);
  const [learnedNodeIds, setLearnedNodeIds] = useState<Set<string>>(new Set());
  const [crossLearnedPositionKeys, setCrossLearnedPositionKeys] = useState<Set<string>>(new Set());
  const [startMode, setStartMode] = useState<'learn' | 'practice' | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null);
  const [linkConflict, setLinkConflict] = useState<IntraLinkConflict | null>(null);
  const [swapCanonical, setSwapCanonical] = useState<{ canonicalId: string; linkNodes: Node[] } | null>(null);

  const parentMap = useMemo(
    () => (tree ? buildParentMap(tree) : new Map<string, Node>()),
    [tree],
  );

  const nodeMap = useMemo(() => {
    if (!tree) return new Map<string, Node>();
    const map = new Map<string, Node>();
    function walk(node: Node) {
      map.set(node.id, node);
      for (const child of node.children ?? []) walk(child);
    }
    walk(tree);
    return map;
  }, [tree]);

  // Index of position_key → node ids that share it. Built once per tree so the
  // per-navigation intra-duplicate check is O(1) instead of scanning all nodes.
  const positionKeyIndex = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const n of nodeMap.values()) {
      const list = m.get(n.position_key);
      if (list) list.push(n.id);
      else m.set(n.position_key, [n.id]);
    }
    return m;
  }, [nodeMap]);

  const linkEntries = useMemo(() => (tree ? collectLinks(tree) : []), [tree]);

  const canonicalTargetIds = useMemo(
    () => new Set(linkEntries.map((e) => e.targetId)),
    [linkEntries],
  );

  const learnableMap = useMemo(
    () => (tree ? computeLearnableMap(tree, opening.color) : new Map<string, boolean>()),
    [tree, opening.color],
  );

  // Stable Set of learnable node ids — passing the inline `new Set(...)`
  // would re-fire MoveList's memo and trigger an O(N) promptSet rebuild
  // on every navigation.
  const learnableSet = useMemo(() => {
    const s = new Set<string>();
    for (const [k, v] of learnableMap) if (v) s.add(k);
    return s;
  }, [learnableMap]);

  const effectiveLearnedNodeIds = useMemo(
    () => tree
      ? augmentLearnedWithTranspositions(tree, opening.color, learnedNodeIds, learnableMap, crossLearnedPositionKeys)
      : learnedNodeIds,
    [tree, opening.color, learnedNodeIds, learnableMap, crossLearnedPositionKeys],
  );

  const totalLearnable = useMemo(() => {
    let n = 0;
    for (const [, l] of learnableMap) if (l) n++;
    return n;
  }, [learnableMap]);

  const learnedLearnableCount = useMemo(() => {
    let n = 0;
    for (const id of effectiveLearnedNodeIds) if (learnableMap.get(id)) n++;
    return n;
  }, [learnableMap, effectiveLearnedNodeIds]);

  // Whether the current node has a transposition available (intra or cross)
  // — drives visibility of the Transpose re-prompt button.
  useEffect(() => {
    if (!currentNode || !id || currentNode === tree) {
      setCurrentHasTrans(false);
      return;
    }
    if (currentNode.transposes_to_node_id) {
      setCurrentHasTrans(true);
      return;
    }
    // Intra check is O(1) via positionKeyIndex.
    const dupIds = positionKeyIndex.get(currentNode.position_key);
    const intraDup = !!dupIds && dupIds.some((nid) => nid !== currentNode.id);
    if (intraDup) {
      setCurrentHasTrans(true);
      return;
    }
    // Cross check needs a DB hit. Debounce so rapid arrow-button navigation
    // doesn't pile up concurrent Supabase queries — only the current node
    // after the user stops navigating actually gets queried.
    setCurrentHasTrans(false);
    let cancelled = false;
    const timer = setTimeout(async () => {
      const parent = parentMap.get(currentNode.id);
      if (!parent) return;
      const cross = await findTransposition(currentNode.fen, parent.fen, id);
      if (!cancelled && cross) setCurrentHasTrans(true);
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [currentNode, id, positionKeyIndex, parentMap, tree]);

  // Refresh targets whenever the set of links changes.
  const linkTargetIdsKey = useMemo(
    () => linkEntries.map((e) => e.targetId).sort().join(','),
    [linkEntries],
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = Array.from(new Set(linkEntries.map((e) => e.targetId)));
      const map = await getTranspositionTargets(ids);
      if (!cancelled) setTransTargets(map);
    })();
    return () => { cancelled = true; };
  }, [linkTargetIdsKey]);

  const linkKinds = useMemo(() => {
    const m = new Map<string, 'intra' | 'cross'>();
    for (const e of linkEntries) {
      const target = transTargets.get(e.targetId);
      const kind = target && target.openingId !== id ? 'cross' : 'intra';
      m.set(e.node.id, kind);
    }
    return m;
  }, [linkEntries, transTargets, id]);

  // Initial load + when id changes
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setTreeReady(false);
      try {
        const [op, nodes, learned, crossKeys] = await Promise.all([
          getOpening(id).catch(() => null),
          getNodes(id),
          getLearnedNodeIds(id).catch(() => new Set<string>()),
          getCrossOpeningLearnedPositionKeys(id).catch(() => new Set<string>()),
        ]);
        if (cancelled) return;
        if (op) setOpening(op);
        setLearnedNodeIds(learned);
        setCrossLearnedPositionKeys(crossKeys);
        const t = buildTree(nodes);
        setTree(t);
        // Honor ?node= deep link
        const target = params.node && t ? findNodeById(t, params.node) : null;
        setCurrentNode(target ?? t);
        setForwardStack([]);
        setLoading(false);
        InteractionManager.runAfterInteractions(() => {
          if (!cancelled) setTreeReady(true);
        });
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // React to ?node= changes that arrive after initial mount (e.g. navigating
  // back to this opening from the practice screen to inspect a mistake).
  const nodeParam = params.node;
  const initialNodeRef = useRef<string | null>(nodeParam ?? null);
  useEffect(() => {
    if (!nodeParam || !tree) return;
    if (initialNodeRef.current === nodeParam) {
      initialNodeRef.current = null;
      return;
    }
    const target = findNodeById(tree, nodeParam);
    if (target) {
      setCurrentNode(target);
      setForwardStack([]);
      setPendingFen(null);
    }
  }, [nodeParam, tree]);

  // Record nav history when arriving via cross-opening jump
  const fromParam = params.from;
  const arrivedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!fromParam || !currentNode) return;
    const arriveKey = `${id}:${currentNode.id}:${fromParam}`;
    if (arrivedRef.current === arriveKey) return;
    arrivedRef.current = arriveKey;
    const [fromOpeningId, fromNodeId] = fromParam.split(':');
    if (fromOpeningId && fromNodeId) {
      navHistory.push({
        from: { openingId: fromOpeningId, nodeId: fromNodeId },
        to: { openingId: id, nodeId: currentNode.id },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromParam, currentNode?.id, id]);

  const reloadTree = useCallback(async (navigateToId?: string) => {
    if (!id) return;
    const nodes = await getNodes(id);
    const t = buildTree(nodes);
    setTree(t);
    if (t) {
      const target = navigateToId ? findNodeById(t, navigateToId) : null;
      setCurrentNode(target ?? t);
    } else {
      setCurrentNode(null);
    }
    setForwardStack([]);
    setPendingFen(null);
  }, [id]);

  const selectNode = useCallback((nodeId: string) => {
    const node = nodeMap.get(nodeId);
    if (node) {
      setCurrentNode(node);
      setForwardStack([]);
      setPendingFen(null);
    }
  }, [nodeMap]);

  // ── Nav ─────────────────────────────────────────────────────────────────

  const goNext = useCallback(() => {
    if (!currentNode) return;
    // If the current node is a link, follow it.
    if (currentNode.transposes_to_node_id) {
      const target = transTargets.get(currentNode.transposes_to_node_id);
      if (target) {
        if (target.openingId === id) {
          // Intra: jump past the canonical to its first child — otherwise
          // the position doesn't change and the board looks frozen.
          const targetNode = nodeMap.get(target.node.id);
          if (targetNode) {
            const landing = targetNode.children?.[0] ?? targetNode;
            navHistory.push({
              from: { openingId: id, nodeId: currentNode.id },
              to: { openingId: id, nodeId: landing.id },
            });
            setCurrentNode(landing);
            setForwardStack([]);
            return;
          }
        } else {
          // Cross: prompt for opening switch.
          setCrossSwitch({ targetInfo: target, fromNodeId: currentNode.id });
          return;
        }
      }
    }
    if (forwardStack.length > 0) {
      let idx = -1;
      for (let i = forwardStack.length - 1; i >= 0; i--) {
        if (parentMap.get(forwardStack[i].id) === currentNode) { idx = i; break; }
      }
      if (idx >= 0) {
        setCurrentNode(forwardStack[idx]);
        setForwardStack(forwardStack.slice(0, idx));
        return;
      }
    }
    if (currentNode.children?.length) {
      setCurrentNode(currentNode.children[0]);
      setForwardStack([]);
    }
  }, [currentNode, forwardStack, parentMap, transTargets, nodeMap, id]);

  const goPrev = useCallback(() => {
    if (!currentNode || !id) return;
    // First try nav history (cross-opening back).
    const entry = navHistory.popIfArrivedAt({ openingId: id, nodeId: currentNode.id });
    if (entry) {
      if (entry.from.openingId === id) {
        const n = nodeMap.get(entry.from.nodeId);
        if (n) { setCurrentNode(n); setForwardStack([]); return; }
      } else {
        router.replace({
          pathname: '/opening/[id]',
          params: { id: entry.from.openingId, node: entry.from.nodeId },
        } as any);
        return;
      }
    }
    if (!parentMap.has(currentNode.id)) return;
    setForwardStack((prev) => [...prev, currentNode]);
    setCurrentNode(parentMap.get(currentNode.id)!);
  }, [currentNode, id, parentMap, navHistory, nodeMap, router]);

  const goToStart = useCallback(() => {
    if (tree) { setCurrentNode(tree); setForwardStack([]); }
  }, [tree]);

  const goToEnd = useCallback(() => {
    if (!currentNode) return;
    let node = currentNode;
    while (node.children && node.children.length > 0) node = node.children[0];
    setCurrentNode(node);
    setForwardStack([]);
  }, [currentNode]);

  // ── Move handler ─────────────────────────────────────────────────────────

  const handleMove = useCallback(async (move: ChessboardMove) => {
    if (!currentNode || !id || saving) return;
    const newFen = move.fen;

    // Existing child reaches this exact position — just navigate.
    const existing = currentNode.children?.find((c) => positionKey(c.fen) === positionKey(newFen));
    if (existing) {
      setCurrentNode(existing);
      setForwardStack([]);
      return;
    }

    setPendingFen(newFen);
    const parentFen = currentNode.fen;
    const parentId = currentNode.id;
    setSaving(true);
    try {
      const newNode = await createNode(id, parentId, move.san, move.uci, newFen);
      await reloadTree(newNode.id);

      const intra = await findIntraOpeningTransposition(newFen, id, newNode.id);
      const cross = intra ? null : await findTransposition(newFen, parentFen, id);

      if (intra || cross) {
        setTransChoice({
          newNodeId: newNode.id,
          newNodeFen: newFen,
          parentId,
          intra,
          cross,
          isReprompt: false,
        });
      }
    } finally {
      setSaving(false);
    }
  }, [currentNode, id, saving, reloadTree]);

  // ── Transposition reprompt ───────────────────────────────────────────────

  const openTransReprompt = useCallback(async (node: Node) => {
    if (!id) return;
    const parent = parentMap.get(node.id);
    if (!parent) return;

    // If this node is a canonical (other nodes link to it), show the swap flow
    // instead — the regular options would be circular/nonsensical.
    const intraLinksToThis = linkEntries.filter((e) => e.targetId === node.id);
    if (intraLinksToThis.length > 0) {
      setSwapCanonical({ canonicalId: node.id, linkNodes: intraLinksToThis.map((e) => e.node) });
      return;
    }

    const intra = await findIntraOpeningTransposition(node.fen, id, node.id);
    const cross = intra ? null : await findTransposition(node.fen, parent.fen, id);
    if (!intra && !cross && !node.transposes_to_node_id) return;
    setTransChoice({
      newNodeId: node.id,
      newNodeFen: node.fen,
      parentId: parent.id,
      intra,
      cross,
      isReprompt: true,
    });
  }, [id, parentMap, linkEntries]);

  // ── Transposition actions ────────────────────────────────────────────────

  const handleCancelNewMove = useCallback(async () => {
    const c = transChoice;
    if (!c || !id) { setTransChoice(null); return; }
    if (c.isReprompt) { setTransChoice(null); return; }
    setSaving(true);
    try {
      await deleteSubtree(c.newNodeId, id);
      await reloadTree(c.parentId);
    } finally {
      setSaving(false);
      setTransChoice(null);
    }
  }, [transChoice, id, reloadTree]);

  const handleLinkIntra = useCallback(async () => {
    const c = transChoice;
    if (!c || !c.intra) return;
    setSaving(true);
    try {
      await linkNode(c.newNodeId, c.intra.canonicalNodeId);
      await reloadTree(c.newNodeId);
    } finally {
      setSaving(false);
      setTransChoice(null);
    }
  }, [transChoice, reloadTree]);

  const handleLinkCross = useCallback(async () => {
    const c = transChoice;
    if (!c || !c.cross) return;
    setSaving(true);
    try {
      await linkNode(c.newNodeId, c.cross.canonicalNodeId);
      await reloadTree(c.newNodeId);
    } finally {
      setSaving(false);
      setTransChoice(null);
    }
  }, [transChoice, reloadTree]);

  const handleAbsorbCrossFromChoice = useCallback(async () => {
    const c = transChoice;
    if (!c?.cross || !id) return;
    setSaving(true);
    try {
      await absorbCrossCanonical(c.newNodeId, c.cross.canonicalNodeId, id);
      await reloadTree(c.newNodeId);
    } finally {
      setSaving(false);
      setTransChoice(null);
    }
  }, [transChoice, id, reloadTree]);

  const handleSwapCanonical = useCallback(async (linkNodeId: string) => {
    const s = swapCanonical;
    if (!s || !id) return;
    setSaving(true);
    try {
      await makeCanonical(id, linkNodeId, s.canonicalId);
      setSwapCanonical(null);
      await reloadTree(linkNodeId);
    } finally {
      setSaving(false);
    }
  }, [swapCanonical, id, reloadTree]);

  const handleMakeGlobalCanonical = useCallback(async () => {
    const c = transChoice;
    if (!c?.intra || !c?.cross || !id) return;
    setSaving(true);
    try {
      await makeCanonical(id, c.newNodeId, c.intra.canonicalNodeId);
      await absorbCrossCanonical(c.newNodeId, c.cross.canonicalNodeId, id);
      await reloadTree(c.newNodeId);
    } finally {
      setSaving(false);
      setTransChoice(null);
    }
  }, [transChoice, id, reloadTree]);

  const handleMakeCanonical = useCallback(async () => {
    const c = confirmCanonical;
    if (!c || !c.intra || !id) return;
    setSaving(true);
    try {
      await makeCanonical(id, c.newNodeId, c.intra.canonicalNodeId);
      await reloadTree(c.newNodeId);
    } finally {
      setSaving(false);
      setConfirmCanonical(null);
      setTransChoice(null);
    }
  }, [confirmCanonical, id, reloadTree]);

  const handleKeepAsNew = useCallback(() => {
    // Cross-only: leave as fresh node, do nothing.
    setTransChoice(null);
  }, []);

  const handleUnlink = useCallback(async (linkNode: Node) => {
    if (!id) return;
    setSaving(true);
    try {
      await unlinkAndPromote(linkNode.id, id, linkNode.position_key);
      await reloadTree(linkNode.id);
    } finally {
      setSaving(false);
    }
  }, [id, reloadTree]);

  const handleAbsorbCross = useCallback(async (linkNode: Node, targetInfo: TargetInfo) => {
    if (!id) return;
    setSaving(true);
    try {
      await absorbCrossCanonical(linkNode.id, targetInfo.node.id, id);
      await reloadTree(linkNode.id);
    } finally {
      setSaving(false);
    }
  }, [id, reloadTree]);

  // ── Delete ───────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (promotedLinkId?: string) => {
    if (!currentNode || !id || !parentMap.has(currentNode.id)) return;
    const parentId = parentMap.get(currentNode.id)!.id;
    setSaving(true);
    try {
      await deleteSubtree(currentNode.id, id, promotedLinkId);
      setLinkConflict(null);
      await reloadTree(promotedLinkId ?? parentId);
    } catch (e: any) {
      if (e instanceof IntraLinkConflict) {
        setLinkConflict(e);
      } else {
        setDeleteBlocked(e?.message ?? 'Could not delete this branch.');
      }
    } finally {
      setSaving(false);
    }
  }, [currentNode, id, parentMap, reloadTree]);

  const handleDeleteLinkReprompt = useCallback(async () => {
    const c = transChoice;
    if (!c?.isReprompt || !id) return;
    const lNode = nodeMap.get(c.newNodeId);
    if (!lNode || !parentMap.has(lNode.id)) return;
    const parentId = parentMap.get(lNode.id)!.id;
    setSaving(true);
    try {
      await deleteSubtree(c.newNodeId, id);
      setTransChoice(null);
      await reloadTree(parentId);
    } catch (e: any) {
      setDeleteBlocked(e?.message ?? 'Could not delete.');
    } finally {
      setSaving(false);
    }
  }, [transChoice, id, nodeMap, parentMap, reloadTree]);

  // ── Annotation ───────────────────────────────────────────────────────────

  const openAnnotationEditor = useCallback(() => {
    if (!currentNode || currentNode === tree) return;
    setAnnotationDraft(currentNode.annotation ?? '');
    setAnnotationOpen(true);
  }, [currentNode, tree]);

  const saveAnnotation = useCallback(async () => {
    if (!currentNode || !id) return;
    const value = annotationDraft.trim() || null;
    if (value === (currentNode.annotation ?? null)) {
      setAnnotationOpen(false);
      return;
    }
    setSaving(true);
    try {
      await updateNodeAnnotation(currentNode.id, value);
      await reloadTree(currentNode.id);
    } finally {
      setSaving(false);
      setAnnotationOpen(false);
    }
  }, [annotationDraft, currentNode, id, reloadTree]);

  // ── PGN import ───────────────────────────────────────────────────────────

  const handlePgnImport = useCallback(async () => {
    if (!id || !pgnText.trim()) return;
    setImportError(null);
    try {
      const result = await importPgnToOpening(id, pgnText, setImportProgress, {
        autoLinkTranspositions: autoLinkPgn,
      });
      await reloadTree(currentNode?.id);
      setPgnOpen(false);
      setPgnText('');
      setImportProgress(null);
      if (!autoLinkPgn && result.transpositionLinks.length > 0) {
        setImportTranspositionCount(result.transpositionLinks.length);
      }
    } catch (err: any) {
      setImportError(err?.message ?? 'Import failed');
    }
  }, [id, pgnText, autoLinkPgn, currentNode?.id, reloadTree]);

  const selectedId = currentNode?.id ?? null;

  // ── Cross-opening switch confirmation ────────────────────────────────────

  const confirmCrossSwitch = useCallback(async () => {
    if (!crossSwitch || !id || !currentNode) return;
    const canonicalId = crossSwitch.targetInfo.node.id;
    const firstChildId = await getFirstChildId(canonicalId);
    const landingId = firstChildId ?? canonicalId;
    navHistory.push({
      from: { openingId: id, nodeId: crossSwitch.fromNodeId },
      to: { openingId: crossSwitch.targetInfo.openingId, nodeId: landingId },
    });
    router.push({
      pathname: '/opening/[id]',
      params: {
        id: crossSwitch.targetInfo.openingId,
        node: landingId,
        name: crossSwitch.targetInfo.openingName,
        color: crossSwitch.targetInfo.openingColor,
      },
    } as any);
    setCrossSwitch(null);
  }, [crossSwitch, id, currentNode, navHistory, router]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-bg-base items-center justify-center">
        <ActivityIndicator color={colorTheme.accent.default} />
      </SafeAreaView>
    );
  }

  if (!tree) {
    return (
      <SafeAreaView className="flex-1 bg-bg-base p-6">
        <Text className="text-content-muted">Opening not found.</Text>
        <Pressable onPress={() => router.back()} className="mt-2">
          <Text className="text-accent text-sm">Back to Library</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const isWhite = opening.color === 'white';
  const boardFen = pendingFen ?? currentNode?.fen ?? tree.fen;
  const boardSize = Math.min(screenWidth - 24, 500);
  const linkTarget = currentNode?.transposes_to_node_id
    ? transTargets.get(currentNode.transposes_to_node_id) ?? null
    : null;
  const hasNext = !!(currentNode?.children?.length) || !!linkTarget;
  const navPeek = navHistory.peek();
  const hasPrev = !!(currentNode && parentMap.has(currentNode.id))
    || !!(currentNode && id && navPeek && navPeek.to.openingId === id && navPeek.to.nodeId === currentNode.id);
  const isRoot = currentNode === tree;

  // Learn/Practice availability. "Learnable" = unique-response user-move;
  // branching positions don't count as needing to be learned.
  const openingColor = opening.color;
  const hasUnlearned = learnedLearnableCount < totalLearnable;
  const hasLearned = effectiveLearnedNodeIds.size > 0;

  return (
    <SafeAreaView className="flex-1 bg-bg-base">
      {/* Header */}
      <View className="flex-row items-center gap-2 px-4 py-2">
        <Pressable
          onPress={() => router.back()}
          className="w-8 h-8 items-center justify-center rounded-lg active:bg-bg-elevated"
        >
          <MaterialCommunityIcons name="arrow-left" size={20} color={colorTheme.content.muted} />
        </Pressable>
        <MaterialCommunityIcons
          name="chess-king"
          size={20}
          color={isWhite ? colorTheme.gold.default : colorTheme.accent.default}
        />
        <Text className="text-content-primary text-base font-semibold flex-1" numberOfLines={1}>
          {opening.name}
        </Text>
        {saving && <ActivityIndicator size="small" color={colorTheme.accent.default} />}
        <Pressable
          onPress={() => hasUnlearned && setStartMode('learn')}
          disabled={!hasUnlearned}
          className={`px-2 py-1 rounded-md flex-row items-center gap-1 ${hasUnlearned ? 'bg-accent/15 active:bg-accent/25' : 'bg-bg-elevated'}`}
        >
          {hasUnlearned && <Text className="text-gold text-[8px]">●</Text>}
          <Text className={`text-xs font-medium ${hasUnlearned ? 'text-accent' : 'text-content-muted'}`}>Learn</Text>
        </Pressable>
        <Pressable
          onPress={() => hasLearned && setStartMode('practice')}
          disabled={!hasLearned}
          className={`px-2 py-1 rounded-md ${hasLearned ? 'bg-gold/15 active:bg-gold/25' : 'bg-bg-elevated'}`}
        >
          <Text className={`text-xs font-medium ${hasLearned ? 'text-gold' : 'text-content-muted'}`}>Practice</Text>
        </Pressable>
        <Pressable
          onPress={() => { setPgnText(''); setImportError(null); setImportProgress(null); setPgnOpen(true); }}
          className="px-2 py-1 rounded-md active:bg-bg-elevated"
        >
          <Text className="text-accent text-xs">Import/Merge PGN</Text>
        </Pressable>
      </View>

      {/* Board */}
      <View className="items-center px-3">
        <View style={{ width: boardSize }}>
          <Chessboard
            fen={boardFen}
            orientation={opening.color}
            onMove={handleMove}
            disabled={saving}
            size={boardSize}
          />
        </View>
      </View>

      {/* Nav controls */}
      <View className="flex-row items-center justify-center gap-2 py-2">
        <NavButton onPress={goToStart} disabled={!hasPrev} icon="skip-previous" />
        <NavButton onPress={goPrev} disabled={!hasPrev} icon="chevron-left" />
        <NavButton onPress={goNext} disabled={!hasNext} icon="chevron-right" />
        <NavButton onPress={goToEnd} disabled={!hasNext} icon="skip-next" />
      </View>

      {/* Current move + annotation */}
      {currentNode?.move_san && (
        <View className="px-4 py-1 flex-row items-center justify-center gap-2">
          <Text className="text-gold text-base font-semibold">
            {movePrefix(currentNode, true)}{currentNode.move_san}
          </Text>
          {linkTarget && (
            <Text style={{ color: linkTarget.openingId === id ? colorTheme.gold.dim : colorTheme.accent.default, fontSize: 13 }}>
              ⇄ {linkTarget.openingId === id ? 'transposes (this opening)' : `→ ${linkTarget.openingName}`}
            </Text>
          )}
        </View>
      )}
      <Pressable
        onPress={openAnnotationEditor}
        disabled={isRoot}
        className="mx-4 mb-1 bg-bg-surface border border-border rounded-lg px-3 py-2 active:opacity-70"
      >
        <Text className={currentNode?.annotation ? 'text-content-secondary text-sm' : 'text-content-muted text-sm italic'}>
          {currentNode?.annotation ?? (isRoot ? 'Select a move to annotate' : 'Add annotation...')}
        </Text>
      </Pressable>

      {/* Panel: Moves / Links toggle */}
      <View className="flex-1 border-t border-border mt-1">
        <View className="flex-row items-center gap-2 px-4 py-2 border-b border-border">
          <Pressable
            onPress={() => setPanelMode('moves')}
            className="flex-row items-center gap-1 px-2 py-1 rounded-md"
            style={{ backgroundColor: panelMode === 'moves' ? colorTheme.bg.elevated : 'transparent' }}
          >
            <MaterialCommunityIcons name="chess-pawn" size={14} color={colorTheme.accent.default} />
            <Text className="text-content-secondary text-xs font-medium uppercase tracking-wider">
              PGN
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setPanelMode('links')}
            className="flex-row items-center gap-1 px-2 py-1 rounded-md"
            style={{ backgroundColor: panelMode === 'links' ? colorTheme.bg.elevated : 'transparent' }}
          >
            <Text style={{ color: colorTheme.accent.default, fontSize: 14 }}>⇄</Text>
            <Text className="text-content-secondary text-xs font-medium uppercase tracking-wider">
              Links {linkEntries.length > 0 ? `(${linkEntries.length})` : ''}
            </Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          {currentNode && !isRoot && panelMode === 'moves' && (
            <>
              {currentHasTrans && (
                <Pressable
                  onPress={() => openTransReprompt(currentNode)}
                  disabled={saving}
                  className="px-2 py-1 rounded-md bg-accent/10 active:bg-accent/20 mr-1"
                >
                  <Text className="text-accent text-xs font-medium">Transpose options</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => handleDelete()}
                disabled={saving}
                className="px-2 py-1 rounded-md bg-danger/15 active:bg-danger/25"
              >
                <Text className="text-danger text-xs font-medium">Delete</Text>
              </Pressable>
            </>
          )}
        </View>
        {panelMode === 'moves' ? (
          treeReady ? (
            <MoveList
              root={tree}
              selectedId={selectedId}
              linkKinds={linkKinds}
              learnedSet={effectiveLearnedNodeIds}
              learnableSet={learnableSet}
              userColor={openingColor}
              canonicalIds={canonicalTargetIds}
              onSelect={selectNode}
              onLongPress={(nodeId) => {
                const n = nodeMap.get(nodeId);
                if (n) openTransReprompt(n);
              }}
            />
          ) : (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator size="small" color={colorTheme.accent.default} />
            </View>
          )
        ) : (
          <LinksPanel
            linkEntries={linkEntries}
            targets={transTargets}
            currentOpeningId={id}
            parentMap={parentMap}
            nodeMap={nodeMap}
            onJump={selectNode}
            onReprompt={openTransReprompt}
            onUnlink={handleUnlink}
            onAbsorb={handleAbsorbCross}
            disabled={saving}
          />
        )}
      </View>

      {/* Learn / Practice start dialog */}
      <Modal
        visible={!!startMode}
        transparent
        animationType="fade"
        onRequestClose={() => setStartMode(null)}
      >
        {startMode && currentNode && (() => {
          const counts = computeApplicableCounts(currentNode, openingColor, effectiveLearnedNodeIds, startMode);
          const fromHereCount = counts.get(currentNode.id) ?? 0;
          const fromHereEnabled = fromHereCount > 0;
          const fromRootEnabled = startMode === 'learn' ? hasUnlearned : hasLearned;
          const isLearn = startMode === 'learn';
          const startUrl = (fromCurrent: boolean) => ({
            pathname: '/practice/[id]',
            params: {
              id,
              mode: startMode,
              ...(fromCurrent && currentNode.id !== tree.id ? { from: currentNode.id } : {}),
            },
          });
          return (
            <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
              <View className="bg-bg-elevated border border-border rounded-xl p-5 w-full max-w-md">
                <Text className="text-content-primary font-semibold text-base mb-1">
                  {isLearn ? 'Learn unlearned positions' : 'Practice learned positions'}
                </Text>
                <Text className="text-content-muted text-sm mb-4">Where do you want to start?</Text>
                <View className="gap-2">
                  <Pressable
                    onPress={() => {
                      setStartMode(null);
                      router.push(startUrl(false) as any);
                    }}
                    disabled={!fromRootEnabled}
                    className={`px-3 py-3 rounded-lg ${
                      fromRootEnabled
                        ? isLearn ? 'bg-accent/15 active:bg-accent/25' : 'bg-gold/15 active:bg-gold/25'
                        : 'bg-bg-surface'
                    }`}
                  >
                    <Text className={`text-sm font-medium ${
                      fromRootEnabled
                        ? isLearn ? 'text-accent' : 'text-gold'
                        : 'text-content-muted'
                    }`}>
                      Whole opening
                    </Text>
                    <Text className={`text-xs mt-0.5 ${fromRootEnabled ? (isLearn ? 'text-accent/70' : 'text-gold/70') : 'text-content-muted'}`}>
                      {isLearn ? 'Find unlearned positions across all branches' : 'Find practice-ready positions across all branches'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      setStartMode(null);
                      router.push(startUrl(true) as any);
                    }}
                    disabled={!fromHereEnabled}
                    className={`px-3 py-3 rounded-lg ${
                      fromHereEnabled
                        ? isLearn ? 'bg-accent/15 active:bg-accent/25' : 'bg-gold/15 active:bg-gold/25'
                        : 'bg-bg-surface'
                    }`}
                  >
                    <Text className={`text-sm font-medium ${
                      fromHereEnabled
                        ? isLearn ? 'text-accent' : 'text-gold'
                        : 'text-content-muted'
                    }`}>
                      This branch only
                    </Text>
                    <Text className={`text-xs mt-0.5 ${fromHereEnabled ? (isLearn ? 'text-accent/70' : 'text-gold/70') : 'text-content-muted'}`}>
                      {fromHereEnabled
                        ? `Positions below ${currentNode.move_san ?? 'the start'} only`
                        : isLearn ? 'Nothing left to learn here' : 'Nothing learned here yet'}
                    </Text>
                  </Pressable>
                </View>
                <Pressable
                  onPress={() => setStartMode(null)}
                  className="mt-4 py-2 rounded-lg border border-border items-center"
                >
                  <Text className="text-content-secondary text-sm">Cancel</Text>
                </Pressable>
              </View>
            </View>
          );
        })()}
      </Modal>

      {/* Delete-blocked dialog */}
      <Modal
        visible={!!deleteBlocked}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteBlocked(null)}
      >
        <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <View className="bg-bg-elevated border border-border rounded-xl p-5 w-full max-w-sm">
            <Text className="text-content-primary font-semibold text-base mb-2">Can't delete this branch</Text>
            <Text className="text-content-secondary text-sm mb-4">{deleteBlocked}</Text>
            <Pressable
              onPress={() => setDeleteBlocked(null)}
              className="py-2 rounded-lg bg-accent/15 active:bg-accent/25 items-center"
            >
              <Text className="text-accent text-sm font-medium">OK</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Swap-canonical picker (when selected node is itself a canonical target) */}
      <Modal
        visible={!!swapCanonical}
        transparent
        animationType="fade"
        onRequestClose={() => setSwapCanonical(null)}
      >
        <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <View className="bg-bg-elevated border border-border rounded-xl p-5 w-full max-w-md">
            <Text className="text-content-primary font-semibold text-base mb-2">Swap canonical</Text>
            <Text className="text-content-secondary text-sm mb-4">
              {swapCanonical?.linkNodes.length === 1
                ? 'One move links to this position.'
                : `${swapCanonical?.linkNodes.length} moves link to this position.`}
              {' '}Select which should become the canonical path:
            </Text>
            <Text className="text-content-secondary text-xs font-medium uppercase tracking-wider mb-2">{opening.name}</Text>
            <View className="gap-2">
              {swapCanonical?.linkNodes.map((ln) => {
                const path = getPathNodes(ln, parentMap);
                const pathStr = keyPathMoves(path).slice(-5).map(moveSanWithNumber).join(' ');
                return (
                  <Pressable
                    key={ln.id}
                    onPress={() => handleSwapCanonical(ln.id)}
                    disabled={saving}
                    className="border border-border rounded-lg px-3 py-2 active:bg-bg-surface"
                    style={{ opacity: saving ? 0.5 : 1 }}
                  >
                    <Text className="text-content-muted text-xs font-mono">{pathStr || ln.move_san || '?'}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Pressable
              onPress={() => setSwapCanonical(null)}
              className="mt-4 py-2 rounded-lg border border-border items-center"
            >
              <Text className="text-content-secondary text-sm">Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* IntraLink conflict picker */}
      <Modal
        visible={!!linkConflict}
        transparent
        animationType="fade"
        onRequestClose={() => setLinkConflict(null)}
      >
        <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <View className="bg-bg-elevated border border-border rounded-xl p-5 w-full max-w-md">
            <Text className="text-content-primary font-semibold text-base mb-2">Choose new canonical</Text>
            <Text className="text-content-secondary text-sm mb-4">
              {linkConflict?.linkNodes.length === 1
                ? 'One move in this opening links to this position.'
                : `${linkConflict?.linkNodes.length} moves in this opening link to this position.`}
              {' '}Select which should become the canonical path:
            </Text>
            <Text className="text-content-secondary text-xs font-medium uppercase tracking-wider mb-2">{opening.name}</Text>
            <View className="gap-2">
              {linkConflict?.linkNodes.map((ln) => {
                const lNode = nodeMap.get(ln.id);
                const path = lNode ? getPathNodes(lNode, parentMap) : [];
                const pathStr = keyPathMoves(path).slice(-5).map(moveSanWithNumber).join(' ');
                return (
                  <Pressable
                    key={ln.id}
                    onPress={() => handleDelete(ln.id)}
                    disabled={saving}
                    className="border border-border rounded-lg px-3 py-2 active:bg-bg-surface"
                    style={{ opacity: saving ? 0.5 : 1 }}
                  >
                    <Text className="text-content-muted text-xs font-mono">{pathStr || ln.move_san || '?'}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Pressable
              onPress={() => setLinkConflict(null)}
              className="mt-4 py-2 rounded-lg border border-border items-center"
            >
              <Text className="text-content-secondary text-sm">Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Choice modal */}
      <Modal
        visible={!!transChoice}
        transparent
        animationType="fade"
        onRequestClose={() => transChoice?.isReprompt ? setTransChoice(null) : handleCancelNewMove()}
      >
        <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <View className="bg-bg-elevated border border-border rounded-xl p-5 w-full max-w-md">
            <Text className="text-content-primary font-semibold text-base mb-2">
              {transChoice?.isReprompt ? 'Transposition' : 'Transposition detected'}
            </Text>
            <Text className="text-content-secondary text-sm mb-4">
              {transChoice?.intra
                ? 'This position can already be reached via a different move order in this opening.'
                : transChoice?.cross
                  ? `This position also appears in ${transChoice.cross.openingName}.`
                  : ''}
            </Text>
            {(() => {
              const canonicalHasOtherLinks = !!(transChoice?.intra && linkEntries.some(
                (e) => e.targetId === transChoice.intra!.canonicalNodeId && e.node.id !== transChoice.newNodeId,
              ));
              return (
            <View className="gap-2">
              {transChoice?.intra && (
                <>
                  <ChoiceButton
                    label={transChoice?.isReprompt ? 'Keep existing link' : 'Link to existing'}
                    desc={transChoice?.isReprompt ? 'No change — keep this move linking to the canonical node.' : 'Make this a transposition into the canonical node.'}
                    onPress={handleLinkIntra}
                    disabled={saving}
                  />
                  {!canonicalHasOtherLinks && (
                    <ChoiceButton
                      label="Make this the canonical for this opening"
                      desc="Move children from the other path onto this node; old node becomes a link."
                      onPress={() => setConfirmCanonical(transChoice)}
                      disabled={saving}
                    />
                  )}
                  {transChoice.isReprompt && (
                    <ChoiceButton
                      label="Delete this position"
                      desc="Remove this link from the opening entirely."
                      onPress={handleDeleteLinkReprompt}
                      disabled={saving}
                    />
                  )}
                </>
              )}
              {transChoice?.cross && !transChoice?.intra && (
                <ChoiceButton
                  label={`Link to ${transChoice.cross.openingName}`}
                  desc="Next moves jump into that opening's line for this position."
                  onPress={handleLinkCross}
                  disabled={saving}
                />
              )}
              {transChoice?.cross && !transChoice?.intra && (
                <ChoiceButton
                  label={`Make this the canonical for all openings`}
                  desc={`${transChoice.cross.openingName} and everything linked to it will be repointed here. Its continuations are merged into this opening.`}
                  onPress={handleAbsorbCrossFromChoice}
                  disabled={saving}
                />
              )}
              {transChoice?.cross && !transChoice?.intra && (
                <ChoiceButton
                  label="Keep as new branching node"
                  desc="Don't link — track this position separately in this opening."
                  onPress={handleKeepAsNew}
                  disabled={saving}
                />
              )}
            </View>
              );
            })()}
            <View className="flex-row gap-2 mt-4">
              <Pressable
                onPress={transChoice?.isReprompt ? () => setTransChoice(null) : handleCancelNewMove}
                disabled={saving}
                className="flex-1 py-2 rounded-lg border border-border items-center"
              >
                <Text className="text-content-secondary text-sm">
                  {transChoice?.isReprompt ? 'Close' : 'Cancel move'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Make-canonical confirmation */}
      <Modal
        visible={!!confirmCanonical}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmCanonical(null)}
      >
        <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <View className="bg-bg-elevated border border-border rounded-xl p-5 w-full max-w-md">
            <Text className="text-content-primary font-semibold text-base mb-2">
              Make this canonical?
            </Text>
            <Text className="text-content-secondary text-sm mb-4">
              The existing canonical's children will be reparented onto this node, and it will become a link to this node. Any cross-opening links to it will be repointed.
            </Text>
            <View className="flex-row gap-2">
              <Pressable
                onPress={() => setConfirmCanonical(null)}
                className="flex-1 py-2 rounded-lg border border-border items-center"
              >
                <Text className="text-content-secondary text-sm">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleMakeCanonical}
                disabled={saving}
                className="flex-1 py-2 rounded-lg bg-accent items-center"
              >
                <Text className="text-bg-base font-medium text-sm">Confirm</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Cross-switch prompt */}
      <Modal
        visible={!!crossSwitch}
        transparent
        animationType="fade"
        onRequestClose={() => setCrossSwitch(null)}
      >
        <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <View className="bg-bg-elevated border border-border rounded-xl p-5 w-full max-w-sm">
            <Text className="text-content-primary font-semibold text-base mb-2">Switch openings?</Text>
            <Text className="text-content-secondary text-sm mb-4">
              This move is a link to "{crossSwitch?.targetInfo.openingName}". Continue there?
            </Text>
            <View className="flex-row gap-2">
              <Pressable
                onPress={() => setCrossSwitch(null)}
                className="flex-1 py-2 rounded-lg border border-border items-center"
              >
                <Text className="text-content-secondary text-sm">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmCrossSwitch}
                className="flex-1 py-2 rounded-lg bg-accent items-center"
              >
                <Text className="text-bg-base font-medium text-sm">Switch</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Post-import review */}
      <Modal
        visible={importTranspositionCount !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setImportTranspositionCount(null)}
      >
        <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <View className="bg-bg-elevated border border-border rounded-xl p-5 w-full max-w-sm">
            <Text className="text-content-primary font-semibold text-base mb-2">
              {importTranspositionCount} transposition{importTranspositionCount === 1 ? '' : 's'} linked
            </Text>
            <Text className="text-content-secondary text-sm mb-4">
              Review them in the Links panel?
            </Text>
            <View className="flex-row gap-2">
              <Pressable
                onPress={() => setImportTranspositionCount(null)}
                className="flex-1 py-2 rounded-lg border border-border items-center"
              >
                <Text className="text-content-secondary text-sm">Later</Text>
              </Pressable>
              <Pressable
                onPress={() => { setPanelMode('links'); setImportTranspositionCount(null); }}
                className="flex-1 py-2 rounded-lg bg-accent items-center"
              >
                <Text className="text-bg-base font-medium text-sm">Open Links</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Annotation editor modal */}
      <Modal
        visible={annotationOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAnnotationOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
        <Pressable
          className="flex-1 items-center justify-center px-6"
          style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
          onPress={() => setAnnotationOpen(false)}
        >
          <Pressable className="bg-bg-elevated border border-border rounded-xl p-5 w-full max-w-md" onPress={() => {}}>
            <Text className="text-content-primary font-semibold text-base mb-3">Annotation</Text>
            <TextInput
              value={annotationDraft}
              onChangeText={setAnnotationDraft}
              placeholder="Notes about this move..."
              placeholderTextColor={colorTheme.content.muted}
              multiline
              autoFocus
              className="bg-bg-surface border border-border rounded-lg px-3 py-2 text-content-primary"
              style={{ minHeight: 80, textAlignVertical: 'top' }}
            />
            <View className="flex-row gap-2 mt-4">
              <Pressable
                onPress={() => setAnnotationOpen(false)}
                className="flex-1 py-2 rounded-lg border border-border items-center"
              >
                <Text className="text-content-secondary text-sm">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={saveAnnotation}
                disabled={saving}
                className="flex-1 py-2 rounded-lg bg-accent items-center"
              >
                <Text className="text-bg-base font-medium text-sm">Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* PGN import modal */}
      <Modal
        visible={pgnOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !importProgress && setPgnOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
        <Pressable
          className="flex-1 items-center justify-center px-6"
          style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
          onPress={() => !importProgress && setPgnOpen(false)}
        >
          <Pressable className="bg-bg-elevated border border-border rounded-xl p-5 w-full max-w-md" onPress={() => {}}>
            <Text className="text-content-primary font-semibold text-base mb-1">Import / Merge PGN</Text>
            <Text className="text-content-muted text-xs mb-3">
              Paste PGN text below. Moves will be merged into the existing tree.
            </Text>
            <TextInput
              value={pgnText}
              onChangeText={setPgnText}
              placeholder="1. e4 e5 2. Nf3 Nc6..."
              placeholderTextColor={colorTheme.content.muted}
              multiline
              editable={!importProgress}
              className="bg-bg-surface border border-border rounded-lg px-3 py-2 text-content-primary"
              style={{ minHeight: 140, textAlignVertical: 'top', fontFamily: 'monospace' }}
            />
            <View className="flex-row items-center gap-2 mt-3">
              <Switch
                value={autoLinkPgn}
                onValueChange={setAutoLinkPgn}
                disabled={!!importProgress}
                trackColor={{ false: colorTheme.bg.surface, true: colorTheme.accent.default }}
              />
              <View style={{ flex: 1 }}>
                <Text className="text-content-secondary text-sm">Auto-link transpositions</Text>
                <Text className="text-content-muted text-xs">
                  {autoLinkPgn
                    ? 'Duplicate positions become links silently.'
                    : 'You\'ll be prompted to review each new link after import.'}
                </Text>
              </View>
            </View>
            {importError && (
              <Text className="text-danger text-xs mt-2">{importError}</Text>
            )}
            {importProgress && (
              <View className="mt-3">
                <View className="flex-row justify-between mb-1">
                  <Text className="text-content-muted text-xs">
                    {importProgress.phase === 'parsing' ? 'Parsing...' : 'Importing...'}
                  </Text>
                  {importProgress.total > 0 && (
                    <Text className="text-content-muted text-xs">
                      {importProgress.current} / {importProgress.total}
                    </Text>
                  )}
                </View>
                <View className="h-1.5 bg-bg-surface rounded-full overflow-hidden">
                  <View
                    className="h-full bg-accent rounded-full"
                    style={{ width: importProgress.total > 0 ? `${(importProgress.current / importProgress.total) * 100}%` : '0%' }}
                  />
                </View>
              </View>
            )}
            <View className="flex-row gap-2 mt-4">
              <Pressable
                onPress={() => setPgnOpen(false)}
                disabled={!!importProgress}
                className="flex-1 py-2 rounded-lg border border-border items-center"
              >
                <Text className="text-content-secondary text-sm">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handlePgnImport}
                disabled={!pgnText.trim() || !!importProgress}
                className="flex-1 py-2 rounded-lg bg-accent items-center"
                style={{ opacity: !pgnText.trim() || !!importProgress ? 0.5 : 1 }}
              >
                <Text className="text-bg-base font-medium text-sm">Import</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

const NavButton = memo(function NavButton({
  onPress, disabled, icon,
}: {
  onPress: () => void;
  disabled: boolean;
  icon: 'skip-previous' | 'chevron-left' | 'chevron-right' | 'skip-next';
}) {
  const { colors: colorTheme } = useColorTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={[
        'w-12 h-10 items-center justify-center rounded-xl bg-bg-surface border border-border',
        disabled ? 'opacity-30' : 'active:bg-accent/5 active:border-accent/40',
      ].join(' ')}
    >
      <MaterialCommunityIcons
        name={icon}
        size={20}
        color={disabled ? colorTheme.content.muted : colorTheme.content.secondary}
      />
    </Pressable>
  );
});

function ChoiceButton({
  label, desc, onPress, disabled,
}: {
  label: string;
  desc: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className="border border-border rounded-lg px-3 py-2 active:bg-bg-surface"
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <Text className="text-content-primary text-sm font-medium">{label}</Text>
      <Text className="text-content-muted text-xs mt-0.5">{desc}</Text>
    </Pressable>
  );
}

function LinksPanel({
  linkEntries, targets, currentOpeningId, parentMap, nodeMap, onJump, onReprompt, onUnlink, onAbsorb, disabled,
}: {
  linkEntries: LinkEntry[];
  targets: Map<string, TargetInfo>;
  currentOpeningId: string;
  parentMap: Map<string, Node>;
  nodeMap: Map<string, Node>;
  onJump: (id: string) => void;
  onReprompt: (n: Node) => void;
  onUnlink: (n: Node) => void;
  onAbsorb: (n: Node, t: TargetInfo) => void;
  disabled: boolean;
}) {
  const { colors: colorTheme } = useColorTheme();

  if (linkEntries.length === 0) {
    return (
      <View className="flex-1 items-center justify-center p-6">
        <Text className="text-content-muted text-sm text-center">
          No transposition links in this opening yet.
        </Text>
      </View>
    );
  }

  // Group link entries by canonical (targetId)
  const groups = new Map<string, LinkEntry[]>();
  for (const entry of linkEntries) {
    const list = groups.get(entry.targetId) ?? [];
    list.push(entry);
    groups.set(entry.targetId, list);
  }

  const fmt = (nodes: Node[]) =>
    nodes.slice(0, 2).map(moveSanWithNumber).join(', ') + (nodes.length > 2 ? ` +${nodes.length - 2}` : '');

  return (
    <ScrollView contentContainerStyle={{ padding: 12 }}>
      {Array.from(groups.entries()).map(([targetId, entries]) => {
        const target = targets.get(targetId);
        const isCross = !!target && target.openingId !== currentOpeningId;

        // Canonical's preceding branching decisions (intra only — cross canonical not in our tree)
        const canonicalVia = !isCross && target
          ? (() => {
              const km = keyPathMoves(getPathNodes(target.node, parentMap)).slice(0, -1);
              return km.length ? fmt(km) : null;
            })()
          : null;

        return (
          <View key={targetId} className="bg-bg-surface border border-border rounded-xl mb-3 overflow-hidden">
            {/* Canonical header */}
            <Pressable
              onPress={() => target && onJump(target.node.id)}
              style={{ backgroundColor: isCross ? colorTheme.accent.default + '18' : colorTheme.gold.default + '12' }}
              className="px-3 pt-2.5 pb-2"
            >
              <View className="flex-row items-center gap-1.5">
                <Text style={{ color: isCross ? colorTheme.accent.default : colorTheme.gold.dim, fontSize: 11 }}>◆</Text>
                <Text className="text-content-primary text-sm font-semibold">
                  {target ? moveSanWithNumber(target.node) : '…'}
                  {canonicalVia ? (
                    <Text style={{ color: colorTheme.content.muted, fontWeight: '400' }}> via {canonicalVia}</Text>
                  ) : null}
                </Text>
              </View>
              {isCross && target && (
                <Text style={{ color: colorTheme.accent.default }} className="text-xs mt-0.5 ml-4">
                  {target.openingName}
                </Text>
              )}
            </Pressable>

            {/* Link rows */}
            {entries.map((entry, idx) => {
              const diff = !isCross && target
                ? computePathDiff(entry.node, target.node, parentMap, nodeMap)
                : null;
              const linkVia = diff?.src.length
                ? fmt(diff.src)
                : isCross
                  ? (() => {
                      const km = keyPathMoves(getPathNodes(entry.node, parentMap)).slice(0, -1);
                      return km.length ? fmt(km) : null;
                    })()
                  : null;

              return (
                <View
                  key={entry.node.id}
                  className={`flex-row items-center gap-2 px-3 py-2${idx < entries.length - 1 ? ' border-b border-border' : ''}`}
                >
                  <Pressable onPress={() => onJump(entry.node.id)} className="flex-1">
                    <Text className="text-content-secondary text-sm">
                      {moveSanWithNumber(entry.node)}
                      {linkVia ? (
                        <Text style={{ color: colorTheme.content.muted }}> via {linkVia}</Text>
                      ) : null}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => onReprompt(entry.node)}
                    disabled={disabled}
                    className="px-2 py-1 rounded-md bg-accent/10 active:bg-accent/20"
                  >
                    <Text className="text-accent text-xs">Change</Text>
                  </Pressable>
                  {isCross && target ? (
                    <>
                      <Pressable
                        onPress={() => onAbsorb(entry.node, target)}
                        disabled={disabled}
                        className="px-2 py-1 rounded-md bg-gold/10 active:bg-gold/20"
                      >
                        <Text className="text-gold text-xs">Absorb</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => onUnlink(entry.node)}
                        disabled={disabled}
                        className="px-2 py-1 rounded-md bg-danger/10 active:bg-danger/20"
                      >
                        <Text className="text-danger text-xs">Unlink</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Text style={{ color: colorTheme.content.muted }} className="text-xs italic">intra</Text>
                  )}
                </View>
              );
            })}
          </View>
        );
      })}
    </ScrollView>
  );
}
