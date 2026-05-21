import { Component, createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useNavHistory } from '@/hooks/useNavHistory';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import Icon from '@mdi/react';
import { mdiChessKing, mdiDelete } from '@mdi/js';
import { AppShell } from '@/components/AppShell';
import {
  getOpening, getNodes, buildTree,
  createNode, deleteSubtree, updateNodeAnnotation,
  findTransposition, findIntraOpeningTransposition,
  linkNode, unlinkAndPromote, makeCanonical, absorbCrossCanonical, getTranspositionTargets, getFirstChildId, positionKey,
  importPgnToOpening,
  treeToPgn,
  IntraLinkConflict,
  type ImportProgress,
  type CrossTranspositionMatch,
  type IntraTranspositionMatch,
  getLearnedNodeIds,
  getCrossOpeningLearnedPositionKeys,
  computeApplicableCounts,
  computeLearnableMap,
  augmentLearnedWithTranspositions,
  type Opening,
  type Node,
} from '@pawnki/shared';
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

function isWhiteMove(node: Node): boolean {
  return !fenInfo(node.fen).isWhite;
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

function findNodeById(root: Node, id: string): Node | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return null;
}

// Returns only the moves that are at branching points plus the final node,
// giving a compact "signature" that distinguishes paths without showing forced
// intermediate moves.
function keyPathMoves(path: Node[]): Node[] {
  const moves = path.slice(1);
  return moves.filter((_, i) => {
    const parent = path[i];
    return (parent.children?.length ?? 0) > 1 || i === moves.length - 1;
  });
}

function countDescendants(node: Node): number {
  let n = 0;
  for (const c of node.children ?? []) {
    n += 1 + countDescendants(c);
  }
  return n;
}

// Defense-in-depth boundary so any future chessboard render error doesn't
// blank the whole page. Resets when the position changes so the board can
// recover on the next move.
interface BoardErrorBoundaryProps {
  resetKey: string;
  children: ReactNode;
}
interface BoardErrorBoundaryState {
  errored: boolean;
}
class BoardErrorBoundary extends Component<BoardErrorBoundaryProps, BoardErrorBoundaryState> {
  state: BoardErrorBoundaryState = { errored: false };

  static getDerivedStateFromError(): BoardErrorBoundaryState {
    return { errored: true };
  }

  componentDidUpdate(prev: BoardErrorBoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.errored) {
      this.setState({ errored: false });
    }
  }

  render() {
    if (this.state.errored) {
      return (
        <div className="w-full h-full flex items-center justify-center text-content-muted text-sm p-4 text-center">
          Board hit a render glitch. Try another move.
        </div>
      );
    }
    return this.props.children;
  }
}

function getLegalMoveSquares(fen: string, sourceSquare: string): string[] {
  try {
    const chess = new Chess(fen);
    const moves = chess.moves({ square: sourceSquare as any, verbose: true });
    return moves.map((m) => m.to);
  } catch {
    return [];
  }
}

// ── Move-tree context ──────────────────────────────────────────────────────
// Threads link-target info to MoveButton without prop drilling. Keyed by
// the target node id (the canonical's id), matching what transposes_to_node_id
// points at.
type LinkTargetInfo = { node: Node; openingId: string; openingName: string; openingColor: 'white' | 'black' };
const LinkTargetsContext = createContext<Map<string, LinkTargetInfo>>(new Map());

// Threads the set of canonical node ids (nodes targeted by link nodes) so
// MoveButton can render the ◆ indicator without prop drilling.
const CanonicalTargetsContext = createContext<Set<string>>(new Set());

// Threads learned-state into MoveButton for the unlearned/learned dot.
interface LearnedCtx {
  learned: Set<string>;
  userColor: 'white' | 'black' | null;
  /** Per-node-id: whether that move is a unique-response user-move
   *  (i.e. reviewable). Branching positions are not learnable. */
  learnableMap: Map<string, boolean>;
}
const LearnedContext = createContext<LearnedCtx>({ learned: new Set(), userColor: null, learnableMap: new Map() });

// ── Main Component ──────────────────────────────────────────────────────────

export default function OpeningDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const navHistory = useNavHistory();
  // Cross-opening switch confirmation. When non-null, modal is shown.
  const [crossSwitch, setCrossSwitch] = useState<{ target: LinkTargetInfo; fromLinkId: string } | null>(null);
  const [startMode, setStartMode] = useState<'learn' | 'practice' | null>(null);
  const [randomOrder, setRandomOrder] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null);
  const [linkConflict, setLinkConflict] = useState<{ conflict: IntraLinkConflict; nodeToDelete: Node } | null>(null);
  const [swapCanonical, setSwapCanonical] = useState<{ canonicalId: string; linkNodes: Node[] } | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [learnedNodeIds, setLearnedNodeIds] = useState<Set<string>>(new Set());
  const [crossLearnedPositionKeys, setCrossLearnedPositionKeys] = useState<Set<string>>(new Set());
  const [tree, setTree] = useState<Node | null>(null);
  const [currentNode, setCurrentNode] = useState<Node | null>(null);
  const [forwardStack, setForwardStack] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const moveListRef = useRef<HTMLDivElement>(null);
  const { colors } = useColorTheme();

  const [saving, setSaving] = useState(false);
  const [pendingFen, setPendingFen] = useState<string | null>(null);
  const [highlightSquares, setHighlightSquares] = useState<Record<string, React.CSSProperties>>({});
  // Square the user has tapped for click-to-move (parallel to drag selection).
  const [activeSquare, setActiveSquare] = useState<string | null>(null);

  const [editingAnnotation, setEditingAnnotation] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState('');

  // Active choice modal triggered after a move arrives at an existing position
  // OR when the user re-prompts the decision on a link/canonical node.
  // `newNodeId` is the node we're deciding what to do with (freshly inserted
  // for create-time, or an existing link for re-prompt).
  const [transChoice, setTransChoice] = useState<{
    newNodeId: string;
    intra: IntraTranspositionMatch | null;
    cross: CrossTranspositionMatch[];
    isReprompt: boolean;
  } | null>(null);
  const [confirmCanonical, setConfirmCanonical] = useState(false);

  // Resolved targets for every link node in this opening — target-id → info.
  const [transTargets, setTransTargets] = useState<Map<string, LinkTargetInfo>>(new Map());
  const [showTransPanel, setShowTransPanel] = useState(false);

  const [showPgnImport, setShowPgnImport] = useState(false);
  const [showPgnExport, setShowPgnExport] = useState(false);
  const [exportCopied, setExportCopied] = useState(false);
  const [pgnText, setPgnText] = useState('');
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [autoLinkPgn, setAutoLinkPgn] = useState(true);
  const [importTranspositionCount, setImportTranspositionCount] = useState<number | null>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: Node } | null>(null);

  const parentMap = useMemo(() => (tree ? buildParentMap(tree) : new Map<string, Node>()), [tree]);

  // id → Node for O(1) lookup. Replaces findNodeById's O(tree) DFS on
  // transposition-jump and nav-history-pop paths.
  const nodeMap = useMemo(() => {
    const m = new Map<string, Node>();
    if (!tree) return m;
    function walk(n: Node) {
      m.set(n.id, n);
      for (const c of n.children ?? []) walk(c);
    }
    walk(tree);
    return m;
  }, [tree]);

  // Collect every link node in the current tree.
  const linkEntries = useMemo(() => {
    const out: { linkId: string; targetId: string; node: Node }[] = [];
    function walk(n: Node) {
      if (n.transposes_to_node_id) out.push({ linkId: n.id, targetId: n.transposes_to_node_id, node: n });
      for (const c of n.children ?? []) walk(c);
    }
    if (tree) walk(tree);
    return out;
  }, [tree]);

  const canonicalTargetIds = useMemo(
    () => new Set(linkEntries.map((e) => e.targetId)),
    [linkEntries],
  );

  // Whenever links change, refresh the target info (one batched fetch).
  useEffect(() => {
    const targetIds = [...canonicalTargetIds];
    if (targetIds.length === 0) {
      setTransTargets(new Map());
      return;
    }
    let cancelled = false;
    getTranspositionTargets(targetIds).then((m) => {
      if (!cancelled) setTransTargets(m);
    });
    return () => { cancelled = true; };
  }, [linkEntries]);

  useEffect(() => {
    if (!id) return;
    const nodeParam = searchParams.get('node') ?? undefined;
    loadData(id, nodeParam);
    if (nodeParam) {
      // Clear the deep-link param so it doesn't re-fire on reload.
      const next = new URLSearchParams(searchParams);
      next.delete('node');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadData(openingId: string, navigateToId?: string) {
    setLoading(true);
    try {
      const [o, nodes, learned, crossKeys] = await Promise.all([
        getOpening(openingId),
        getNodes(openingId),
        getLearnedNodeIds(openingId).catch(() => new Set<string>()),
        getCrossOpeningLearnedPositionKeys(openingId).catch(() => new Set<string>()),
      ]);
      setOpening(o);
      setLearnedNodeIds(learned);
      setCrossLearnedPositionKeys(crossKeys);
      const t = buildTree(nodes);
      setTree(t);
      if (navigateToId && t) {
        const target = findNodeById(t, navigateToId);
        setCurrentNode(target ?? t);
      } else {
        setCurrentNode(t);
      }
      setForwardStack([]);
    } finally {
      setLoading(false);
    }
  }

  async function reloadTree(navigateToId?: string) {
    if (!id) return;
    const nodes = await getNodes(id);
    const t = buildTree(nodes);
    setTree(t);
    // Always update currentNode to a node from the new tree
    if (t) {
      const targetId = navigateToId ?? currentNode?.id;
      const target = targetId ? findNodeById(t, targetId) : null;
      setCurrentNode(target ?? t);
    } else {
      setCurrentNode(null);
    }
    setForwardStack([]);
    setPendingFen(null);
  }

  const selectNode = useCallback((node: Node) => {
    setCurrentNode(node);
    setForwardStack([]);
    setEditingAnnotation(false);
    setPendingFen(null);
    setContextMenu(null);
    setActiveSquare(null);
    setHighlightSquares({});
  }, []);

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

  const goNext = useCallback(() => {
    if (!currentNode || !id) return;

    // If the current node is a transposition link, follow it.
    if (currentNode.transposes_to_node_id) {
      const target = transTargets.get(currentNode.transposes_to_node_id);
      if (target) {
        if (target.openingId === id) {
          // Intra-opening: jump past the canonical to its first child —
          // otherwise the position doesn't change and the board looks frozen.
          if (tree) {
            const targetInTree = nodeMap.get(target.node.id) ?? null;
            if (targetInTree) {
              const landing = targetInTree.children?.[0] ?? targetInTree;
              navHistory.push({
                from: { openingId: id, nodeId: currentNode.id },
                to: { openingId: id, nodeId: landing.id },
              });
              setCurrentNode(landing);
              setForwardStack([]);
              return;
            }
          }
        } else {
          // Cross-opening: confirm before switching openings.
          setCrossSwitch({ target, fromLinkId: currentNode.id });
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
  }, [currentNode, forwardStack, parentMap, transTargets, id, tree, navHistory, nodeMap]);

  const goPrev = useCallback(() => {
    if (!currentNode || !id) return;

    // If we arrived here via a transposition jump, pop back to the source —
    // even if that source is in a different opening.
    const popped = navHistory.popIfArrivedAt({ openingId: id, nodeId: currentNode.id });
    if (popped) {
      if (popped.from.openingId === id) {
        if (tree) {
          const src = nodeMap.get(popped.from.nodeId) ?? null;
          if (src) {
            setForwardStack((prev) => [...prev, currentNode]);
            setCurrentNode(src);
            return;
          }
        }
      } else {
        // Cross-opening: route change with deep link.
        navigate(`/library/${popped.from.openingId}?node=${popped.from.nodeId}`);
        return;
      }
    }

    if (!parentMap.has(currentNode.id)) return;
    setForwardStack((prev) => [...prev, currentNode]);
    setCurrentNode(parentMap.get(currentNode.id)!);
  }, [currentNode, parentMap, id, tree, navHistory, navigate, nodeMap]);

  // ── Delete ───────────────────────────────────────────────────────────────

  const handleDeleteNode = useCallback(async (nodeToDelete?: Node, promotedLinkId?: string) => {
    const target = nodeToDelete ?? currentNode;
    if (!target || !id || !parentMap.has(target.id)) return;
    const parentId = parentMap.get(target.id)!.id;
    setSaving(true);
    try {
      await deleteSubtree(target.id, id, promotedLinkId);
      setLinkConflict(null);
      await reloadTree(promotedLinkId ?? parentId);
    } catch (e: any) {
      if (e instanceof IntraLinkConflict) {
        setLinkConflict({ conflict: e, nodeToDelete: target });
      } else {
        setDeleteBlocked(e?.message ?? 'Could not delete this branch.');
      }
    } finally {
      setSaving(false);
      setContextMenu(null);
    }
  }, [currentNode, id, parentMap]);

  // ── Keyboard ─────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'ArrowRight': e.preventDefault(); goNext(); break;
        case 'ArrowLeft': e.preventDefault(); goPrev(); break;
        case 'Home': e.preventDefault(); goToStart(); break;
        case 'End': e.preventDefault(); goToEnd(); break;
        case 'Delete':
        case 'Backspace':
          if (currentNode && parentMap.has(currentNode.id) && !saving) {
            e.preventDefault();
            handleDeleteNode();
          }
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev, goToStart, goToEnd, handleDeleteNode, currentNode, parentMap, saving]);

  // Auto-scroll selected move into view — scroll only the move list container.
  // scrollIntoView walks every scrollable ancestor, which on mobile drags the
  // page itself and pushes the board off-screen.
  const scrollTargetId = currentNode?.id;
  useEffect(() => {
    if (!scrollTargetId) return;
    const timer = setTimeout(() => {
      const container = moveListRef.current;
      if (!container) return;
      const el = container.querySelector(`[data-node-id="${scrollTargetId}"]`) as HTMLElement | null;
      if (!el) return;
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const delta = (elRect.top - containerRect.top) - (containerRect.height / 2) + (elRect.height / 2);
      container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' });
    }, 60);
    return () => clearTimeout(timer);
  }, [scrollTargetId]);

  // Close context menu on click elsewhere
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  // ── Legal move highlighting ──────────────────────────────────────────────

  // react-chessboard memoizes its internal dnd-kit handleDragStart with deps
  // `[currentPosition]`. After a move our currentNode changes but the visible
  // fen string is unchanged (pendingFen was already showing it), so the dnd-kit
  // callback never re-captures handlePieceDrag — it keeps the previous closure
  // and reads a stale currentNode. Route through a ref so the handler is
  // referentially stable and always reads the latest node.
  const liveNodeRef = useRef(currentNode);
  useEffect(() => { liveNodeRef.current = currentNode; }, [currentNode]);
  const liveColorsRef = useRef(colors);
  useEffect(() => { liveColorsRef.current = colors; }, [colors]);

  const handlePieceDrag = useCallback(({ square }: { isSparePiece: boolean; piece: { pieceType: string }; square: string | null }) => {
    const node = liveNodeRef.current;
    const c = liveColorsRef.current;
    if (!node || !square) { setHighlightSquares({}); return; }
    const targets = getLegalMoveSquares(node.fen, square);
    const styles: Record<string, React.CSSProperties> = {};
    styles[square] = { backgroundColor: c.accent.dim, opacity: 0.6 };
    const chess = new Chess(node.fen);
    for (const target of targets) {
      const isCapture = chess.get(target as any);
      styles[target] = isCapture
        ? { background: `radial-gradient(circle, transparent 55%, ${c.accent.default} 55%, ${c.accent.default} 68%, transparent 68%)` }
        : { background: `radial-gradient(circle, ${c.accent.default} 25%, transparent 25%)`, opacity: 0.8 };
    }
    setHighlightSquares(styles);
  }, []);

  // ── Board interaction ────────────────────────────────────────────────────

  const tryApplyMove = useCallback((sourceSquare: string, targetSquare: string): boolean => {
    if (!currentNode || !id || saving) return false;

    const chess = new Chess(currentNode.fen);
    // chess.js v1 throws on illegal moves. If we let the throw escape from
    // onPieceDrop, react-chessboard's drag cleanup is skipped and the piece
    // is left at opacity 0.5 (the dragging-ghost style).
    let result;
    try {
      result = chess.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
    } catch {
      result = null;
    }
    if (!result) return false;

    const newFen = chess.fen();

    const newKey = positionKey(newFen);
    const existing = currentNode.children?.find((c) => c.position_key === newKey);
    if (existing) {
      setCurrentNode(existing);
      setForwardStack([]);
      return true;
    }

    setPendingFen(newFen);

    const parentId = currentNode.id;
    // Compute user's move path (root → new node) so findTransposition can
    // distinguish real transpositions from literal shared-trunk duplicates.
    const userPathSans = [
      ...getPathNodes(currentNode, parentMap)
        .map((n) => n.move_san)
        .filter((s): s is string => !!s),
      result.san,
    ];
    setSaving(true);
    createNode(id, parentId, result.san, result.from + result.to + (result.promotion ?? ''), newFen)
      .then(async (newNode) => {
        await reloadTree(newNode.id);
        const [intra, cross] = await Promise.all([
          findIntraOpeningTransposition(newFen, id, newNode.id),
          findTransposition(newFen, id, userPathSans),
        ]);
        if (intra || cross.length > 0) {
          setTransChoice({ newNodeId: newNode.id, intra, cross, isReprompt: false });
        }
      })
      .finally(() => setSaving(false));

    return true;
  }, [currentNode, id, saving, parentMap]);

  const handlePieceDrop = useCallback(({ sourceSquare, targetSquare }: {
    piece: unknown;
    sourceSquare: string;
    targetSquare: string | null;
  }): boolean => {
    setHighlightSquares({});
    setActiveSquare(null);
    if (!targetSquare) return false;
    return tryApplyMove(sourceSquare, targetSquare);
  }, [tryApplyMove]);

  const isUserPiece = useCallback((piece: { pieceType: string } | null | undefined): boolean => {
    if (!currentNode || !piece) return false;
    const { isWhite } = fenInfo(currentNode.fen);
    return isWhite === (piece.pieceType[0] === 'w');
  }, [currentNode]);

  // Click-to-move: tap own piece to select; tap another square to move (or
  // switch selection if it's another own piece); tap same square to deselect.
  const showLegalForSquare = useCallback((square: string) => {
    if (!currentNode) return;
    const targets = getLegalMoveSquares(currentNode.fen, square);
    const styles: Record<string, React.CSSProperties> = {};
    const chess = new Chess(currentNode.fen);
    for (const target of targets) {
      const isCapture = chess.get(target as any);
      styles[target] = isCapture
        ? { background: `radial-gradient(circle, transparent 55%, ${colors.accent.default} 55%, ${colors.accent.default} 68%, transparent 68%)` }
        : { background: `radial-gradient(circle, ${colors.accent.default} 25%, transparent 25%)`, opacity: 0.8 };
    }
    setHighlightSquares(styles);
  }, [currentNode, colors]);

  const handleSquareClick = useCallback(({ square, piece }: { square: string | null; piece: { pieceType: string } | null }) => {
    if (!currentNode || saving || !square) return;
    if (activeSquare && square !== activeSquare) {
      if (isUserPiece(piece)) {
        setActiveSquare(square);
        showLegalForSquare(square);
        return;
      }
      tryApplyMove(activeSquare, square);
      setActiveSquare(null);
      setHighlightSquares({});
      return;
    }
    if (square === activeSquare) {
      setActiveSquare(null);
      setHighlightSquares({});
      return;
    }
    if (isUserPiece(piece)) {
      setActiveSquare(square);
      showLegalForSquare(square);
    }
  }, [currentNode, saving, activeSquare, isUserPiece, tryApplyMove, showLegalForSquare]);

  const canDragPiece = useCallback(({ piece }: { isSparePiece: boolean; piece: { pieceType: string }; square: string | null }): boolean => {
    if (!currentNode || saving) return false;
    return isUserPiece(piece);
  }, [currentNode, saving, isUserPiece]);

  // ── Annotation save ──────────────────────────────────────────────────────

  async function saveAnnotation() {
    if (!currentNode || !id) return;
    const value = annotationDraft.trim() || null;
    if (value === (currentNode.annotation ?? null)) {
      setEditingAnnotation(false);
      return;
    }
    setSaving(true);
    try {
      await updateNodeAnnotation(currentNode.id, value);
      await reloadTree(currentNode.id);
    } finally {
      setSaving(false);
      setEditingAnnotation(false);
    }
  }

  // ── PGN import ───────────────────────────────────────────────────────────

  async function handlePgnImport() {
    if (!id || !pgnText.trim()) return;
    setImportError(null);
    try {
      const result = await importPgnToOpening(id, pgnText, setImportProgress, {
        autoLinkTranspositions: autoLinkPgn,
      });
      await reloadTree(currentNode?.id);
      setShowPgnImport(false);
      setPgnText('');
      setImportProgress(null);
      // When auto-link was disabled, surface what got linked so the user
      // can review/promote any of them.
      if (!autoLinkPgn && result.transpositionLinks.length > 0) {
        setImportTranspositionCount(result.transpositionLinks.length);
      }
    } catch (err: any) {
      setImportError(err.message ?? 'Import failed');
    }
  }

  // ── Transposition choice handlers ────────────────────────────────────────

  const closeTransChoice = useCallback(() => {
    setTransChoice(null);
    setConfirmCanonical(false);
  }, []);

  const handleLinkIntra = useCallback(async () => {
    if (!transChoice?.intra || !id) return;
    setSaving(true);
    try {
      await linkNode(transChoice.newNodeId, transChoice.intra.canonicalNodeId);
      await reloadTree(transChoice.newNodeId);
    } finally {
      setSaving(false);
      closeTransChoice();
    }
  }, [transChoice, id, closeTransChoice]);

  const handleMakeCanonical = useCallback(async () => {
    if (!transChoice?.intra || !id) return;
    setSaving(true);
    try {
      await makeCanonical(id, transChoice.newNodeId, transChoice.intra.canonicalNodeId);
      await reloadTree(transChoice.newNodeId);
    } finally {
      setSaving(false);
      closeTransChoice();
    }
  }, [transChoice, id, closeTransChoice]);

  const handleLinkCross = useCallback(async (canonicalNodeId: string) => {
    if (!transChoice || !id) return;
    setSaving(true);
    try {
      await linkNode(transChoice.newNodeId, canonicalNodeId);
      await reloadTree(transChoice.newNodeId);
    } finally {
      setSaving(false);
      closeTransChoice();
    }
  }, [transChoice, id, closeTransChoice]);

  const handleKeepAsNew = useCallback(() => {
    closeTransChoice();
  }, [closeTransChoice]);

  const handleCancelNewMove = useCallback(async () => {
    if (!transChoice || !id) return;
    setSaving(true);
    try {
      await deleteSubtree(transChoice.newNodeId, id);
      // After cancel, jump back to the parent (which is what currentNode was before).
      const parentId = tree ? buildParentMap(tree).get(transChoice.newNodeId)?.id : undefined;
      await reloadTree(parentId);
    } finally {
      setSaving(false);
      closeTransChoice();
    }
  }, [transChoice, id, tree, closeTransChoice]);

  const handleUnlink = useCallback(async () => {
    if (!transChoice || !id || !tree) return;
    const node = findNodeById(tree, transChoice.newNodeId);
    if (!node) return;
    setSaving(true);
    try {
      // Cross-opening unlink promotes this node to canonical and re-points
      // any other intra-opening duplicates at it.
      await unlinkAndPromote(node.id, id, node.position_key);
      await reloadTree(node.id);
    } finally {
      setSaving(false);
      closeTransChoice();
    }
  }, [transChoice, id, tree, closeTransChoice]);

  const handleAbsorbCross = useCallback(async (targetNodeId: string) => {
    if (!transChoice || !id) return;
    setSaving(true);
    try {
      await absorbCrossCanonical(transChoice.newNodeId, targetNodeId, id);
      await reloadTree(transChoice.newNodeId);
    } finally {
      setSaving(false);
      closeTransChoice();
    }
  }, [transChoice, id, closeTransChoice]);

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
  }, [swapCanonical, id]);

  // Open the choice modal for an existing node (re-prompt the original decision).
  const openTransReprompt = useCallback(async (node: Node) => {
    if (!id || !tree) return;

    // If this node is a canonical (other nodes link to it), show the swap flow.
    const intraLinksToThis = linkEntries.filter((e) => e.targetId === node.id);
    if (intraLinksToThis.length > 0) {
      setContextMenu(null);
      setSwapCanonical({ canonicalId: node.id, linkNodes: intraLinksToThis.map((e) => e.node) });
      return;
    }

    const userPathSans = getPathNodes(node, parentMap)
      .map((n) => n.move_san)
      .filter((s): s is string => !!s);
    const [intra, cross] = await Promise.all([
      findIntraOpeningTransposition(node.fen, id, node.id),
      findTransposition(node.fen, id, userPathSans),
    ]);
    setContextMenu(null);
    setTransChoice({ newNodeId: node.id, intra, cross, isReprompt: true });
  }, [id, tree, parentMap, linkEntries]);

  const handleMoveContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    if (!parentMap.has(node.id)) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, [parentMap]);

  const openingColor = opening?.color;

  const learnableMap = useMemo(() => {
    // Return early from the memoized function if data isn't ready yet.
    // (Return an empty map, array, or null depending on what computeLearnableMap expects)
    if (!tree || !openingColor) return new Map();

    return computeLearnableMap(tree, openingColor);
  }, [tree, openingColor]);

  const effectiveLearnedNodeIds = useMemo(
    () => tree && openingColor
      ? augmentLearnedWithTranspositions(tree, openingColor, learnedNodeIds, learnableMap, crossLearnedPositionKeys)
      : learnedNodeIds,
    [tree, openingColor, learnedNodeIds, learnableMap, crossLearnedPositionKeys],
  );

  const totalLearnable = useMemo(() => {
    let n = 0;
    for (const [, learnable] of learnableMap) if (learnable) n++;
    return n;
  }, [learnableMap]);

  const learnedLearnableCount = useMemo(() => {
    let n = 0;
    for (const nid of effectiveLearnedNodeIds) if (learnableMap.get(nid)) n++;
    return n;
  }, [effectiveLearnedNodeIds, learnableMap]);

  // Stable Context value — passing an inline object literal would re-render
  // every MoveButton consumer on every parent render, regardless of memo.
  const learnedCtxValue = useMemo(
    () => ({ learned: effectiveLearnedNodeIds, userColor: opening?.color ?? null, learnableMap }),
    [effectiveLearnedNodeIds, opening?.color, learnableMap],
  );

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <AppShell>
        <div className="flex-1 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      </AppShell>
    );
  }

  if (!opening || !tree) {
    return (
      <AppShell>
        <div className="flex-1 p-8">
          <p className="text-content-muted">Opening not found.</p>
          <Link to="/library" className="text-accent text-sm mt-2 inline-block hover:underline">
            Back to Library
          </Link>
        </div>
      </AppShell>
    );
  }

  const boardFen = pendingFen ?? currentNode?.fen ?? tree.fen;
  const boardOrientation = opening.color === 'white' ? 'white' : 'black';
  const hasUnlearned = learnedLearnableCount < totalLearnable;
  const hasLearned = effectiveLearnedNodeIds.size > 0;
  const hasLinkTarget = !!(currentNode?.transposes_to_node_id && transTargets.get(currentNode.transposes_to_node_id));
  const hasNext = !!(currentNode?.children?.length) || hasLinkTarget;
  const hasPrev = !!(currentNode && (parentMap.has(currentNode.id) || navHistory.peek()));
  const isRoot = currentNode === tree;

  return (
    <AppShell>
      <div className="flex-1 flex flex-col lg:flex-row h-full overflow-hidden">
        {/* ── Board column ── */}
        <div className="flex flex-col items-center shrink-0 p-3 lg:flex-1 lg:p-6 lg:justify-center lg:overflow-hidden">
          {/* Title bar */}
          <div className="w-full flex items-center gap-2 mb-2 min-w-0">
            <Link
              to={`/library${opening.color === 'black' ? '?color=black' : ''}`}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-content-muted hover:text-content-primary hover:bg-bg-elevated transition-colors shrink-0"
              title="Back to Library"
            >
              ←
            </Link>
            <Icon
              path={mdiChessKing}
              size={0.9}
              color={`rgb(var(--color-${opening.color === 'white' ? 'gold' : 'accent'}))`}
              className="shrink-0"
            />
            <h1 className="text-content-primary text-lg font-semibold truncate">{opening.name}</h1>
            <div className="ml-auto flex items-center gap-1 shrink-0">
              {saving && (
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin mr-1" />
              )}
              <button
                onClick={() => setStartMode('learn')}
                disabled={!hasUnlearned}
                title={hasUnlearned ? 'Learn unlearned positions' : 'Everything in this opening is learned'}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors inline-flex items-center gap-1 ${hasUnlearned
                    ? 'bg-accent/15 text-accent hover:bg-accent/25'
                    : 'bg-bg-elevated text-content-muted cursor-not-allowed'
                  }`}
              >
                {hasUnlearned && <span aria-hidden className="text-gold text-[0.55em] leading-none">●</span>}
                Learn
              </button>
              <button
                onClick={() => setStartMode('practice')}
                disabled={!hasLearned}
                title={hasLearned ? 'Practice learned positions' : 'Learn this opening first to unlock practice'}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${hasLearned
                    ? 'bg-gold/15 text-gold hover:bg-gold/25'
                    : 'bg-bg-elevated text-content-muted cursor-not-allowed'
                  }`}
              >
                Practice
              </button>
              <button
                disabled
                title="Master-game frequencies for this position — coming soon"
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-bg-elevated text-content-muted cursor-not-allowed inline-flex items-center gap-1"
              >
                Database
                <span className="text-[0.6rem] uppercase tracking-wider opacity-60">soon</span>
              </button>
              <button
                disabled
                title="Engine evaluation and best-move hints — coming soon"
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-bg-elevated text-content-muted cursor-not-allowed inline-flex items-center gap-1"
              >
                Analysis
                <span className="text-[0.6rem] uppercase tracking-wider opacity-60">soon</span>
              </button>
            </div>
          </div>

          {/* Board */}
          <div className="w-full aspect-square max-h-[calc(100vh-220px)] max-w-[calc(100vh-220px)]">
            <BoardErrorBoundary resetKey={boardFen}>
              <Chessboard
                options={{
                  position: boardFen,
                  boardOrientation: boardOrientation,
                  allowDragging: true,
                  animationDurationInMs: 200,
                  boardStyle: {
                    borderRadius: '8px',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                  },
                  darkSquareStyle: { backgroundColor: colors.board.dark },
                  lightSquareStyle: { backgroundColor: colors.board.light },
                  squareStyles: activeSquare
                    ? {
                        ...highlightSquares,
                        [activeSquare]: {
                          backgroundColor: 'rgb(var(--color-accent) / 0.5)',
                          boxShadow: 'inset 0 0 0 4px rgb(var(--color-accent))',
                          ...(highlightSquares[activeSquare] ?? {}),
                        },
                      }
                    : highlightSquares,
                  onPieceDrop: handlePieceDrop,
                  onPieceDrag: handlePieceDrag,
                  onSquareClick: handleSquareClick,
                  canDragPiece: canDragPiece,
                  dropSquareStyle: { backgroundColor: colors.accent.dim },
                }}
              />
            </BoardErrorBoundary>
          </div>

          {/* Nav controls */}
          <div className="flex items-center gap-1 mt-2">
            <NavButton onClick={goToStart} disabled={!hasPrev} title="Start (Home)">⏮</NavButton>
            <NavButton onClick={goPrev} disabled={!hasPrev} title="Previous (←)">◀</NavButton>
            <NavButton onClick={goNext} disabled={!hasNext} title="Next (→)">▶</NavButton>
            <NavButton onClick={goToEnd} disabled={!hasNext} title="End (End)">⏭</NavButton>
          </div>

          {/* Annotation */}
          <div className="w-full mt-2">
            {editingAnnotation && currentNode && !isRoot ? (
              <div className="bg-bg-surface border border-accent/30 rounded-lg overflow-hidden">
                <textarea
                  autoFocus
                  value={annotationDraft}
                  onChange={(e) => setAnnotationDraft(e.target.value)}
                  onBlur={saveAnnotation}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveAnnotation(); } }}
                  placeholder="Add annotation..."
                  className="w-full px-3 py-2 bg-transparent text-content-secondary text-sm resize-none outline-none min-h-[60px]"
                  rows={2}
                />
              </div>
            ) : currentNode && !isRoot && currentNode.annotation ? (
              <button
                onClick={() => { setEditingAnnotation(true); setAnnotationDraft(currentNode?.annotation ?? ''); }}
                className="w-full text-left bg-bg-surface border border-border rounded-lg px-3 py-2 hover:border-accent/30 transition-colors"
              >
                <p className="text-content-secondary text-sm">{currentNode.annotation}</p>
              </button>
            ) : (
              <button
                onClick={() => { if (currentNode && !isRoot) { setEditingAnnotation(true); setAnnotationDraft(''); } }}
                className="w-full text-left bg-bg-surface border border-border rounded-lg px-3 py-2 hover:border-accent/30 transition-colors"
              >
                <p className="text-content-muted text-sm italic">
                  {currentNode && !isRoot ? 'Add annotation...' : 'Select a move to annotate'}
                </p>
              </button>
            )}
          </div>
        </div>

        {/* ── Move tree panel ── */}
        <div className="relative border-t lg:border-t-0 lg:border-l border-border bg-bg-surface flex flex-col shrink-0 min-h-0 max-h-[40vh] lg:max-h-none lg:w-80 xl:w-96">
          {/* Panel header */}
          <div className="px-4 py-3 border-b border-border shrink-0 flex items-center gap-2">
            <button
              onClick={() => setShowTransPanel(false)}
              className={`text-xs font-medium uppercase tracking-wider transition-colors ${showTransPanel ? 'text-content-muted hover:text-content-secondary' : 'text-content-secondary'}`}
            >
              <span className="text-accent text-xs mr-1">♟</span>PGN
            </button>
            <button
              onClick={() => setShowTransPanel(true)}
              className={`text-xs font-medium uppercase tracking-wider transition-colors ${showTransPanel ? 'text-content-secondary' : 'text-content-muted hover:text-content-secondary'}`}
              title="View transposition links"
            >
              <span className="text-accent text-xs mr-1">⇄</span>Links
              {linkEntries.length > 0 && (
                <span className="ml-1 px-1 rounded bg-accent/20 text-accent text-[0.65rem] align-middle">{linkEntries.length}</span>
              )}
            </button>
            <div className="ml-auto flex items-center gap-3">
              <button
                onClick={() => { setShowPgnExport(true); setExportCopied(false); }}
                disabled={!tree}
                className="text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Export PGN"
              >
                Export PGN
              </button>
              <button
                onClick={() => { setShowPgnImport(true); setImportError(null); setPgnText(''); setImportProgress(null); }}
                className="text-xs text-accent hover:text-accent-hover transition-colors"
                title="Import/Merge PGN"
              >
                Import/Merge PGN
              </button>
            </div>
          </div>
          {showTransPanel ? (
            <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 min-h-0">
              <TranspositionsPanel
                links={linkEntries}
                targets={transTargets}
                currentOpeningId={id!}
                parentMap={parentMap}
                nodeMap={nodeMap}
                onGoTo={(n) => { selectNode(n); setShowTransPanel(false); }}
                onEdit={(n) => { openTransReprompt(n); setShowTransPanel(false); }}
                onUnlink={async (n) => {
                  setSaving(true);
                  try {
                    await unlinkAndPromote(n.id, id!, n.position_key);
                    await reloadTree(n.id);
                  } finally { setSaving(false); }
                }}
                onAbsorb={async (n, targetNodeId) => {
                  setSaving(true);
                  try {
                    await absorbCrossCanonical(n.id, targetNodeId, id!);
                    await reloadTree(n.id);
                  } finally { setSaving(false); }
                }}
              />
            </div>
          ) : (
            <div ref={moveListRef} className="flex-1 overflow-y-auto overflow-x-hidden p-3 pb-14 min-h-0">
              <LinkTargetsContext.Provider value={transTargets}>
                <CanonicalTargetsContext.Provider value={canonicalTargetIds}>
                  <LearnedContext.Provider value={learnedCtxValue}>
                    <MoveTree
                      root={tree}
                      selected={currentNode}
                      highlightColor={colors.gold.default}
                      onSelect={selectNode}
                      onContextMenu={handleMoveContextMenu}
                    />
                  </LearnedContext.Provider>
                </CanonicalTargetsContext.Provider>
              </LinkTargetsContext.Provider>
            </div>
          )}
          {/* Floating delete button */}
          {!isRoot && (
            <button
              onClick={() => handleDeleteNode()}
              disabled={saving}
              className="absolute bottom-3 right-3 w-9 h-9 flex items-center justify-center rounded-full bg-danger text-white hover:brightness-110 transition-all shadow-lg disabled:opacity-50"
              title="Delete selected move (Delete)"
            >
              <Icon path={mdiDelete} size={0.75} />
            </button>
          )}
        </div>
      </div>

      {/* ── Context menu ── */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-bg-elevated border border-border rounded-xl shadow-lg py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { selectNode(contextMenu.node); setContextMenu(null); }}
            className="w-full text-left px-3 py-2 text-sm text-content-primary hover:bg-bg-surface transition-colors"
          >
            Go to move
          </button>
          <button
            onClick={() => { openTransReprompt(contextMenu.node); }}
            className="w-full text-left px-3 py-2 text-sm text-content-primary hover:bg-bg-surface transition-colors"
          >
            {contextMenu.node.transposes_to_node_id ? 'Change transposition link…' : 'Transpositions…'}
          </button>
          <button
            onClick={() => { handleDeleteNode(contextMenu.node); }}
            className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-bg-surface transition-colors"
          >
            Delete subtree
          </button>
        </div>
      )}

      {/* ── Transposition choice modal ── */}
      {transChoice && tree && (() => {
        const node = findNodeById(tree, transChoice.newNodeId);
        const isLinked = !!node?.transposes_to_node_id;
        const currentLinkTarget = node?.transposes_to_node_id ? transTargets.get(node.transposes_to_node_id) : null;
        const isCrossLink = !!(currentLinkTarget && currentLinkTarget.openingId !== id);
        const isIntraLink = isLinked && !isCrossLink;
        const oldCanonical = transChoice.intra
          ? findNodeById(tree, transChoice.intra.canonicalNodeId)
          : null;
        const reparentCount = oldCanonical ? countDescendants(oldCanonical) : 0;
        const canonicalHasOtherLinks = !!(transChoice.intra && linkEntries.some(
          (e) => e.targetId === transChoice.intra!.canonicalNodeId && e.node.id !== transChoice.newNodeId,
        ));

        if (transChoice.isReprompt && !transChoice.intra && transChoice.cross.length === 0 && !isLinked) {
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeTransChoice}>
              <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-content-primary font-semibold mb-2">No transpositions for this position</h3>
                <p className="text-content-secondary text-sm mb-4">This position doesn't appear elsewhere in this opening or in any other opening.</p>
                <button onClick={closeTransChoice} className="w-full py-2 rounded-lg bg-bg-surface border border-border text-content-secondary text-sm hover:bg-bg-elevated transition-colors">Close</button>
              </div>
            </div>
          );
        }

        if (confirmCanonical && transChoice.intra) {
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
              <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-sm mx-4 shadow-2xl">
                <h3 className="text-content-primary font-semibold mb-2">Make this the canonical position?</h3>
                <p className="text-content-secondary text-sm mb-2">
                  The existing route (via <span className="text-accent font-medium">{transChoice.intra.moveSan ?? '?'}</span>) will become a link to your current move.
                </p>
                <p className="text-content-secondary text-sm mb-4">
                  {reparentCount === 0
                    ? 'The original position has no continuations yet, so nothing else will move.'
                    : <>
                      <span className="text-content-primary font-medium">{reparentCount}</span> continuation
                      {reparentCount === 1 ? '' : 's'} will be re-rooted onto your current move.
                    </>}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmCanonical(false)}
                    disabled={saving}
                    className="flex-1 py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface transition-colors disabled:opacity-50"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleMakeCanonical}
                    disabled={saving}
                    className="flex-1 py-2 rounded-lg bg-accent text-bg-base font-medium text-sm hover:bg-accent-hover transition-colors disabled:opacity-50"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            </div>
          );
        }

        const crossList = transChoice.cross;
        const crossNamesNode = crossList.length === 0 ? null
          : crossList.length === 1
            ? <span className="text-accent font-medium">{crossList[0].openingName}</span>
            : <>{crossList.map((m, i) => (
                <span key={m.openingId}>
                  {i > 0 && (i === crossList.length - 1 ? ' and ' : ', ')}
                  <span className="text-accent font-medium">{m.openingName}</span>
                </span>
              ))}</>;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-md mx-4 shadow-2xl">
              <h3 className="text-content-primary font-semibold mb-2">{transChoice.isReprompt ? 'Transposition' : 'Transposition detected'}</h3>
              <p className="text-content-secondary text-sm mb-4">
                {transChoice.intra && crossList.length > 0
                  ? <>This position already exists in this opening (via <span className="text-accent font-medium">{transChoice.intra.moveSan ?? '?'}</span>) and in {crossNamesNode}.</>
                  : transChoice.intra
                    ? <>This position can also be reached in this opening via <span className="text-accent font-medium">{transChoice.intra.moveSan ?? '?'}</span>.</>
                    : <>This position also appears in {crossNamesNode}.</>
                }
              </p>

              <div className="flex flex-col gap-2">
                {transChoice.intra && (
                  <button
                    onClick={handleLinkIntra}
                    disabled={saving}
                    className="text-left px-3 py-2 rounded-lg bg-bg-surface border border-border hover:border-accent/40 transition-colors disabled:opacity-50"
                  >
                    <div className="text-content-primary text-sm font-medium">{transChoice.isReprompt ? 'Keep existing link' : 'Link to existing line'}</div>
                    <div className="text-content-muted text-xs mt-0.5">{transChoice.isReprompt ? 'No change — keep this move linking to the canonical node.' : 'This move becomes a link; the original line stays canonical.'}</div>
                  </button>
                )}
                {transChoice.intra && !canonicalHasOtherLinks && (
                  <button
                    onClick={() => setConfirmCanonical(true)}
                    disabled={saving}
                    className="text-left px-3 py-2 rounded-lg bg-bg-surface border border-border hover:border-accent/40 transition-colors disabled:opacity-50"
                  >
                    <div className="text-content-primary text-sm font-medium">Make this the canonical for this opening</div>
                    <div className="text-content-muted text-xs mt-0.5">
                      {reparentCount > 0
                        ? `Moves ${reparentCount} continuation${reparentCount === 1 ? '' : 's'} onto your current move.`
                        : 'The original move becomes a link to this one.'}
                    </div>
                  </button>
                )}
                {!transChoice.intra && crossList.map((m) => (
                  <button
                    key={`link-${m.openingId}`}
                    onClick={() => handleLinkCross(m.canonicalNodeId)}
                    disabled={saving}
                    className="text-left px-3 py-2 rounded-lg bg-bg-surface border border-border hover:border-accent/40 transition-colors disabled:opacity-50"
                  >
                    <div className="text-content-primary text-sm font-medium">
                      Link to <span className="text-accent">{m.openingName}</span>
                    </div>
                    <div className="text-content-muted text-xs mt-0.5">Next moves jump into that opening's line for this position.</div>
                  </button>
                ))}
                {!transChoice.intra && !isCrossLink && crossList.map((m) => (
                  <button
                    key={`absorb-${m.openingId}`}
                    onClick={() => handleAbsorbCross(m.canonicalNodeId)}
                    disabled={saving}
                    className="text-left px-3 py-2 rounded-lg bg-bg-surface border border-border hover:border-accent/40 transition-colors disabled:opacity-50"
                  >
                    <div className="text-content-primary text-sm font-medium">
                      Absorb <span className="text-accent">{m.openingName}</span> into this opening
                    </div>
                    <div className="text-content-muted text-xs mt-0.5">
                      <span className="text-accent">{m.openingName}</span> and everything linked to it will be repointed here. Its continuations are merged into this opening.
                    </div>
                  </button>
                ))}
                {/* Only allow "Keep as local canonical" when there's no
                    same-opening duplicate. A position must have exactly one
                    branching node per opening. */}
                {!transChoice.intra && (
                  <button
                    onClick={handleKeepAsNew}
                    disabled={saving}
                    className="text-left px-3 py-2 rounded-lg bg-bg-surface border border-border hover:border-accent/40 transition-colors disabled:opacity-50"
                  >
                    <div className="text-content-primary text-sm font-medium">Keep as local canonical</div>
                    <div className="text-content-muted text-xs mt-0.5">Don't link to another opening; this move stays as the canonical for this opening.</div>
                  </button>
                )}
              </div>

              {/* Cross-opening links only: absorb the other opening's branches
                  into this opening, making this node the global canonical. */}
              {isCrossLink && currentLinkTarget && (
                <button
                  onClick={() => handleAbsorbCross(currentLinkTarget.node.id)}
                  disabled={saving}
                  className="text-left px-3 py-2 rounded-lg bg-bg-surface border border-border hover:border-accent/40 transition-colors disabled:opacity-50 mt-2 w-full"
                >
                  <div className="text-content-primary text-sm font-medium">
                    Absorb {currentLinkTarget.openingName}'s branches into this opening
                  </div>
                  <div className="text-content-muted text-xs mt-0.5">
                    Moves all continuations from {currentLinkTarget.openingName} onto this line and links the other opening back to this one.
                  </div>
                </button>
              )}

              {/* Unlink is only meaningful for cross-opening links — for
                  intra-opening links it would create a duplicate branching
                  node, which the invariant forbids. */}
              {isCrossLink && (
                <button
                  onClick={handleUnlink}
                  disabled={saving}
                  className="text-left px-3 py-2 rounded-lg bg-bg-surface border border-border hover:border-danger/40 transition-colors disabled:opacity-50 mt-2 w-full"
                >
                  <div className="text-danger text-sm font-medium">Unlink</div>
                  <div className="text-content-muted text-xs mt-0.5">
                    Detach the cross-opening link. This move becomes the canonical for the position in this opening.
                  </div>
                </button>
              )}
              {isIntraLink && node && (
                <button
                  onClick={() => { closeTransChoice(); handleDeleteNode(node); }}
                  disabled={saving}
                  className="text-left px-3 py-2 rounded-lg bg-bg-surface border border-border hover:border-danger/40 transition-colors disabled:opacity-50 mt-2 w-full"
                >
                  <div className="text-danger text-sm font-medium">Delete this position</div>
                  <div className="text-content-muted text-xs mt-0.5">Remove this link from the opening entirely.</div>
                </button>
              )}

              <button
                onClick={transChoice.isReprompt ? closeTransChoice : handleCancelNewMove}
                disabled={saving}
                className="w-full mt-3 py-2 rounded-lg text-content-muted text-sm hover:text-danger transition-colors disabled:opacity-50"
              >
                {transChoice.isReprompt ? 'Close' : 'Cancel — undo this move'}
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── Cross-opening switch confirmation ── */}
      {crossSwitch && id && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setCrossSwitch(null)}>
          <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-content-primary font-semibold mb-2">Continue in another opening?</h3>
            <p className="text-content-secondary text-sm mb-4">
              This move links to <span className="text-accent font-medium">{crossSwitch.target.openingName}</span>. Continuing will switch to that opening at the matching position.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setCrossSwitch(null)}
                className="flex-1 py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface transition-colors"
              >
                Stay here
              </button>
              <button
                onClick={async () => {
                  const canonicalId = crossSwitch.target.node.id;
                  const targetOpening = crossSwitch.target.openingId;
                  // Land on the canonical's first child if any, so the board
                  // actually advances past the (same-position) canonical.
                  const firstChildId = await getFirstChildId(canonicalId);
                  const landingId = firstChildId ?? canonicalId;
                  navHistory.push({
                    from: { openingId: id, nodeId: crossSwitch.fromLinkId },
                    to: { openingId: targetOpening, nodeId: landingId },
                  });
                  setCrossSwitch(null);
                  navigate(`/library/${targetOpening}?node=${landingId}`);
                }}
                className="flex-1 py-2 rounded-lg bg-accent text-bg-base font-medium text-sm hover:bg-accent-hover transition-colors"
              >
                Switch
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Swap-canonical picker ── */}
      {swapCanonical && opening && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setSwapCanonical(null)}>
          <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-md mx-4 shadow-2xl w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-content-primary font-semibold mb-2">Swap canonical</h3>
            <p className="text-content-secondary text-sm mb-4">
              {swapCanonical.linkNodes.length === 1
                ? 'One move links to this position.'
                : `${swapCanonical.linkNodes.length} moves link to this position.`}
              {' '}Select which should become the canonical path:
            </p>
            <p className="text-content-secondary text-xs font-medium uppercase tracking-wider mb-2">{opening.name}</p>
            <div className="flex flex-col gap-2">
              {swapCanonical.linkNodes.map((ln) => {
                const path = getPathNodes(ln, parentMap);
                const pathStr = keyPathMoves(path).slice(-5).map(moveSanWithNumber).join(' ');
                return (
                  <button
                    key={ln.id}
                    onClick={() => handleSwapCanonical(ln.id)}
                    disabled={saving}
                    className="text-left px-3 py-2 rounded-lg bg-bg-surface border border-border hover:border-accent/40 transition-colors disabled:opacity-50"
                  >
                    <div className="text-content-muted text-xs font-mono">{pathStr || ln.move_san || '?'}</div>
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => setSwapCanonical(null)}
              className="w-full mt-4 py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Delete-blocked dialog ── */}
      {deleteBlocked && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setDeleteBlocked(null)}>
          <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-content-primary font-semibold mb-2">Can't delete this branch</h3>
            <p className="text-content-secondary text-sm mb-4">{deleteBlocked}</p>
            <button
              onClick={() => setDeleteBlocked(null)}
              className="w-full py-2 rounded-lg bg-accent/15 text-accent text-sm font-medium hover:bg-accent/25"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* ── IntraLink conflict picker ── */}
      {linkConflict && opening && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setLinkConflict(null)}>
          <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-md mx-4 shadow-2xl w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-content-primary font-semibold mb-2">Choose new canonical</h3>
            <p className="text-content-secondary text-sm mb-4">
              {linkConflict.conflict.linkNodes.length === 1
                ? 'One move in this opening links to this position.'
                : `${linkConflict.conflict.linkNodes.length} moves in this opening link to this position.`}
              {' '}Select which should become the canonical path:
            </p>
            <p className="text-content-secondary text-xs font-medium uppercase tracking-wider mb-2">{opening.name}</p>
            <div className="flex flex-col gap-2">
              {linkConflict.conflict.linkNodes.map((ln) => {
                const lNode = nodeMap.get(ln.id);
                const path = lNode ? getPathNodes(lNode, parentMap) : [];
                const pathStr = keyPathMoves(path).slice(-5).map(moveSanWithNumber).join(' ');
                return (
                  <button
                    key={ln.id}
                    onClick={() => handleDeleteNode(linkConflict.nodeToDelete, ln.id)}
                    disabled={saving}
                    className="text-left px-3 py-2 rounded-lg bg-bg-surface border border-border hover:border-accent/40 transition-colors disabled:opacity-50"
                  >
                    <div className="text-content-muted text-xs font-mono">{pathStr || ln.move_san || '?'}</div>
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => setLinkConflict(null)}
              className="w-full mt-4 py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Learn / Practice start dialog ── */}
      {startMode && opening && currentNode && id && (() => {
        const counts = computeApplicableCounts(currentNode, opening.color, effectiveLearnedNodeIds, startMode);
        const fromHereCount = counts.get(currentNode.id) ?? 0;
        const fromHereEnabled = fromHereCount > 0;
        const fromRootEnabled = startMode === 'learn' ? hasUnlearned : hasLearned;
        const isLearn = startMode === 'learn';
        const enabledCls = isLearn
          ? 'bg-accent/15 text-accent hover:bg-accent/25'
          : 'bg-gold/15 text-gold hover:bg-gold/25';
        const title = isLearn ? 'Learn unlearned positions' : 'Practice learned positions';
        const startUrl = (fromCurrent: boolean) =>
          `/practice/${id}?mode=${startMode}${fromCurrent && currentNode.id !== tree.id ? `&from=${currentNode.id}` : ''}${!isLearn && randomOrder ? '&random=1' : ''}`;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setStartMode(null)}>
            <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-sm mx-4 shadow-2xl w-full" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-content-primary font-semibold mb-1">{title}</h3>
              <p className="text-content-muted text-sm mb-4">Where do you want to start?</p>
              {!isLearn && (
                <label className="flex items-center gap-2 mb-4 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={randomOrder}
                    onChange={(e) => setRandomOrder(e.target.checked)}
                    className="w-4 h-4 rounded accent-gold"
                  />
                  <span className="text-content-secondary text-sm">Random order</span>
                </label>
              )}
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => { setStartMode(null); navigate(startUrl(false)); }}
                  disabled={!fromRootEnabled}
                  className={[
                    'w-full px-3 py-2.5 rounded-lg text-sm font-medium text-left transition-colors',
                    fromRootEnabled
                      ? enabledCls
                      : 'bg-bg-surface text-content-muted cursor-not-allowed',
                  ].join(' ')}
                >
                  Whole opening
                  <span className="block text-xs opacity-70 mt-0.5">
                    {isLearn ? 'Find unlearned positions across all branches' : 'Find practice-ready positions across all branches'}
                  </span>
                </button>
                <button
                  onClick={() => { setStartMode(null); navigate(startUrl(true)); }}
                  disabled={!fromHereEnabled}
                  title={
                    fromHereEnabled
                      ? undefined
                      : isLearn
                        ? 'Nothing unlearned in this subtree.'
                        : 'Nothing learned in this subtree yet.'
                  }
                  className={[
                    'w-full px-3 py-2.5 rounded-lg text-sm font-medium text-left transition-colors',
                    fromHereEnabled
                      ? enabledCls
                      : 'bg-bg-surface text-content-muted cursor-not-allowed',
                  ].join(' ')}
                >
                  This branch only
                  <span className="block text-xs opacity-70 mt-0.5">
                    {fromHereEnabled
                      ? `Positions below ${currentNode.move_san ?? 'the start'} only`
                      : isLearn
                        ? 'Nothing left to learn here'
                        : 'Nothing learned here yet'}
                  </span>
                </button>
              </div>
              <button
                onClick={() => setStartMode(null)}
                className="mt-4 w-full py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface"
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── PGN post-import transposition review ── */}
      {importTranspositionCount !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setImportTranspositionCount(null)}>
          <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-content-primary font-semibold mb-2">
              {importTranspositionCount} transposition{importTranspositionCount === 1 ? '' : 's'} linked
            </h3>
            <p className="text-content-secondary text-sm mb-4">
              The imported PGN reached {importTranspositionCount === 1 ? 'a position' : `${importTranspositionCount} positions`} that already existed in this opening. The new move{importTranspositionCount === 1 ? ' was' : 's were'} inserted as link{importTranspositionCount === 1 ? '' : 's'}. Open the Links panel to review or change them.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setImportTranspositionCount(null)}
                className="flex-1 py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface transition-colors"
              >
                Later
              </button>
              <button
                onClick={() => {
                  setShowTransPanel(true);
                  setImportTranspositionCount(null);
                }}
                className="flex-1 py-2 rounded-lg bg-accent text-bg-base font-medium text-sm hover:bg-accent-hover transition-colors"
              >
                Open Links
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PGN import modal ── */}
      {showPgnImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !importProgress && setShowPgnImport(false)}>
          <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-content-primary font-semibold">Import/Merge PGN</h3>
              <label className="text-xs text-accent hover:underline cursor-pointer">
                Load file…
                <input
                  type="file"
                  accept=".pgn,text/plain,application/x-chess-pgn"
                  className="hidden"
                  disabled={!!importProgress}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      const text = await file.text();
                      setPgnText(text);
                    } finally {
                      e.target.value = '';
                    }
                  }}
                />
              </label>
            </div>
            <p className="text-content-muted text-xs mb-2">
              Paste or load PGN text. Moves will be merged into the existing tree.
            </p>
            <textarea
              value={pgnText}
              onChange={(e) => setPgnText(e.target.value)}
              placeholder="1. e4 e5 2. Nf3 Nc6..."
              className="w-full h-40 bg-bg-surface border border-border rounded-lg px-3 py-2 text-content-primary text-sm font-mono resize-none outline-none focus:border-accent/40 transition-colors"
              disabled={!!importProgress}
            />
            <label className="flex items-start gap-2 mt-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoLinkPgn}
                onChange={(e) => setAutoLinkPgn(e.target.checked)}
                disabled={!!importProgress}
                className="mt-0.5 accent-accent disabled:opacity-50"
              />
              <span className="text-content-secondary text-xs">
                <span className="text-content-primary">Auto-link transpositions</span>
                <br />
                <span className="text-content-muted">
                  When PGN reaches a position that already exists in this opening via another move order, link the new move to the existing line. {autoLinkPgn ? 'Disable to review them after import.' : 'You\'ll be shown the new links to review after import.'}
                </span>
              </span>
            </label>
            {importError && (
              <p className="text-danger text-xs mt-2">{importError}</p>
            )}
            {importProgress && (
              <div className="mt-3">
                <div className="flex justify-between text-xs text-content-muted mb-1">
                  <span>{importProgress.phase === 'parsing' ? 'Parsing...' : 'Importing...'}</span>
                  {importProgress.total > 0 && (
                    <span>{importProgress.current} / {importProgress.total}</span>
                  )}
                </div>
                <div className="h-1.5 bg-bg-surface rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent rounded-full transition-all"
                    style={{ width: importProgress.total > 0 ? `${(importProgress.current / importProgress.total) * 100}%` : '0%' }}
                  />
                </div>
              </div>
            )}
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setShowPgnImport(false)}
                disabled={!!importProgress}
                className="flex-1 py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handlePgnImport}
                disabled={!pgnText.trim() || !!importProgress}
                className="flex-1 py-2 rounded-lg bg-accent text-bg-base font-medium text-sm hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PGN export modal ── */}
      {showPgnExport && tree && opening && (() => {
        const pgn = treeToPgn(tree, {
          event: opening.name,
          white: opening.color === 'white' ? 'You' : '?',
          black: opening.color === 'black' ? 'You' : '?',
        });
        const handleCopy = async () => {
          try {
            await navigator.clipboard.writeText(pgn);
            setExportCopied(true);
            setTimeout(() => setExportCopied(false), 1500);
          } catch {/* no-op */}
        };
        const handleDownload = () => {
          const safe = opening.name.replace(/[^\w.-]+/g, '_') || 'opening';
          const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${safe}.pgn`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        };
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowPgnExport(false)}>
            <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-content-primary font-semibold mb-2">Export PGN</h3>
              <p className="text-content-muted text-xs mb-2">
                Variations and annotations are preserved. Transposition links are emitted as normal moves.
              </p>
              <textarea
                readOnly
                value={pgn}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full h-48 bg-bg-surface border border-border rounded-lg px-3 py-2 text-content-primary text-xs font-mono resize-none outline-none focus:border-accent/40 transition-colors"
              />
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => setShowPgnExport(false)}
                  className="flex-1 py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface transition-colors"
                >
                  Close
                </button>
                <button
                  onClick={handleCopy}
                  className="flex-1 py-2 rounded-lg border border-border text-content-secondary text-sm hover:bg-bg-surface transition-colors"
                >
                  {exportCopied ? 'Copied' : 'Copy'}
                </button>
                <button
                  onClick={handleDownload}
                  className="flex-1 py-2 rounded-lg bg-accent text-bg-base font-medium text-sm hover:bg-accent-hover transition-colors"
                >
                  Download .pgn
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </AppShell>
  );
}

function NavButton({ onClick, disabled, title, children }: {
  onClick: () => void;
  disabled: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="w-10 h-10 flex items-center justify-center rounded-xl bg-bg-surface border border-border text-content-secondary hover:text-accent hover:border-accent/40 hover:bg-accent/5 transition-all disabled:opacity-30 disabled:hover:text-content-secondary disabled:hover:border-border disabled:hover:bg-bg-surface"
    >
      {children}
    </button>
  );
}

// ── Move Tree Renderer ──────────────────────────────────────────────────────

function collectMainRun(start: Node): Node[] {
  const run: Node[] = [start];
  let cur = start;
  while (cur.children && cur.children.length === 1) {
    cur = cur.children[0];
    run.push(cur);
  }
  return run;
}

function MoveTree({ root, selected, highlightColor, onSelect, onContextMenu }: {
  root: Node;
  selected: Node | null;
  highlightColor: string;
  onSelect: (n: Node) => void;
  onContextMenu: (e: React.MouseEvent, n: Node) => void;
}) {
  if (!root.children?.length) {
    return <p className="text-content-muted text-sm">No moves yet. Drag a piece on the board to start.</p>;
  }
  return <MoveLine nodes={root.children} selected={selected} highlightColor={highlightColor} onSelect={onSelect} onContextMenu={onContextMenu} />;
}

function MoveLine({ nodes, selected, highlightColor, onSelect, onContextMenu }: {
  nodes: Node[];
  selected: Node | null;
  highlightColor: string;
  onSelect: (n: Node) => void;
  onContextMenu: (e: React.MouseEvent, n: Node) => void;
}) {
  if (nodes.length === 0) return null;
  const [main, ...alts] = nodes;
  const mainRun = collectMainRun(main);
  const lastInRun = mainRun[mainRun.length - 1];
  const branchesAfterRun = lastInRun.children ?? [];

  const rowHasSelected = mainRun.some((n) => n.id === selected?.id);

  return (
    <>
      <div
        data-move-row
        className="flex flex-wrap items-baseline gap-x-0.5 gap-y-0.5 rounded px-1 -mx-1"
        style={rowHasSelected ? { backgroundColor: `${highlightColor}18` } : undefined}
      >
        {mainRun.map((node, i) => (
          <MoveButton key={node.id} node={node} selected={selected?.id === node.id} onSelect={onSelect} onContextMenu={onContextMenu} forceNumber={i === 0} />
        ))}
      </div>

      {alts.map((alt) => (
        <VariationBlock key={alt.id} node={alt} selected={selected} highlightColor={highlightColor} onSelect={onSelect} onContextMenu={onContextMenu} />
      ))}

      {branchesAfterRun.length > 0 && (
        <MoveLine nodes={branchesAfterRun} selected={selected} highlightColor={highlightColor} onSelect={onSelect} onContextMenu={onContextMenu} />
      )}
    </>
  );
}

function VariationBlock({ node, selected, highlightColor, onSelect, onContextMenu }: {
  node: Node;
  selected: Node | null;
  highlightColor: string;
  onSelect: (n: Node) => void;
  onContextMenu: (e: React.MouseEvent, n: Node) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const run = collectMainRun(node);
  const lastInRun = run[run.length - 1];
  const branchesAfterRun = lastInRun.children ?? [];
  const isLong = run.length > 4 || branchesAfterRun.length > 0;

  const rowHasSelected = run.some((n) => n.id === selected?.id);

  return (
    <div className="border-l-2 pl-2 my-0.5 ml-1" style={{ borderColor: `${highlightColor}40` }}>
      <div
        data-move-row
        className="flex flex-wrap items-baseline gap-x-0.5 gap-y-0.5 rounded px-1 -mx-1"
        style={rowHasSelected ? { backgroundColor: `${highlightColor}18` } : undefined}
      >
        {isLong && (
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-accent/50 hover:text-accent text-xs mr-0.5 select-none transition-colors"
            title={collapsed ? 'Expand variation' : 'Collapse variation'}
          >
            {collapsed ? '▶' : '▼'}
          </button>
        )}
        {collapsed ? (
          <MoveButton node={run[0]} selected={selected?.id === run[0].id} onSelect={onSelect} onContextMenu={onContextMenu} forceNumber />
        ) : (
          run.map((n, i) => (
            <MoveButton key={n.id} node={n} selected={selected?.id === n.id} onSelect={onSelect} onContextMenu={onContextMenu} forceNumber={i === 0} />
          ))
        )}
        {collapsed && <span className="text-content-muted text-xs select-none">...</span>}
      </div>

      {!collapsed && branchesAfterRun.length > 0 && (
        <MoveLine nodes={branchesAfterRun} selected={selected} highlightColor={highlightColor} onSelect={onSelect} onContextMenu={onContextMenu} />
      )}
    </div>
  );
}

function TranspositionsPanel({ links, targets, currentOpeningId, parentMap, nodeMap, onGoTo, onEdit, onUnlink, onAbsorb }: {
  links: { linkId: string; targetId: string; node: Node }[];
  targets: Map<string, LinkTargetInfo>;
  currentOpeningId: string;
  parentMap: Map<string, Node>;
  nodeMap: Map<string, Node>;
  onGoTo: (n: Node) => void;
  onEdit: (n: Node) => void;
  onUnlink: (n: Node) => void;
  onAbsorb: (n: Node, targetNodeId: string) => void;
}) {
  if (links.length === 0) {
    return (
      <p className="text-content-muted text-sm">
        No transposition links yet. When a move you make also exists elsewhere, you'll be prompted to link it.
      </p>
    );
  }

  // Group links by canonical (targetId).
  const groups = new Map<string, typeof links>();
  for (const entry of links) {
    const list = groups.get(entry.targetId) ?? [];
    list.push(entry);
    groups.set(entry.targetId, list);
  }

  const fmt = (nodes: Node[]) =>
    nodes.slice(0, 2).map(moveSanWithNumber).join(', ') + (nodes.length > 2 ? ` +${nodes.length - 2}` : '');

  return (
    <ul className="flex flex-col gap-3">
      {Array.from(groups.entries()).map(([targetId, entries]) => {
        const t = targets.get(targetId);
        const isCross = !!(t && t.openingId !== currentOpeningId);

        const canonicalVia = !isCross && t
          ? (() => {
              const path = getPathNodes(t.node, parentMap);
              const km = keyPathMoves(path).slice(0, -1);
              return km.length ? fmt(km) : null;
            })()
          : null;

        return (
          <li key={targetId} className="bg-bg-base border border-border rounded-lg overflow-hidden">
            {/* Canonical header */}
            <button
              onClick={() => t && onGoTo(t.node)}
              disabled={!t}
              className={`w-full text-left px-3 pt-2.5 pb-2 transition-colors ${isCross ? 'bg-accent/10 hover:bg-accent/15' : 'bg-gold/[0.08] hover:bg-gold/[0.15]'} disabled:cursor-default`}
            >
              <div className="flex items-center gap-1.5">
                <span className={`text-[0.65em] ${isCross ? 'text-accent' : 'text-gold/60'}`}>◆</span>
                <span className="text-content-primary text-sm font-medium">
                  {t ? moveSanWithNumber(t.node) : '…'}
                  {canonicalVia && (
                    <span className="text-content-muted font-normal"> via {canonicalVia}</span>
                  )}
                </span>
              </div>
              {isCross && t && (
                <p className="text-accent text-xs mt-0.5 ml-4">{t.openingName}</p>
              )}
            </button>

            {/* Link rows */}
            {entries.map((entry, idx) => {
              const diff = !isCross && t ? computePathDiff(entry.node, t.node, parentMap, nodeMap) : null;
              const linkVia = diff?.src.length
                ? fmt(diff.src)
                : isCross
                  ? (() => {
                      const km = keyPathMoves(getPathNodes(entry.node, parentMap)).slice(0, -1);
                      return km.length ? fmt(km) : null;
                    })()
                  : null;

              return (
                <div
                  key={entry.node.id}
                  className={`flex items-center gap-2 px-3 py-2${idx < entries.length - 1 ? ' border-b border-border' : ''}`}
                >
                  <button
                    onClick={() => onGoTo(entry.node)}
                    className="flex-1 text-left text-content-secondary text-sm hover:text-content-primary transition-colors min-w-0"
                  >
                    <span>{moveSanWithNumber(entry.node)}</span>
                    {linkVia && (
                      <span className="text-content-muted"> via {linkVia}</span>
                    )}
                  </button>
                  <button
                    onClick={() => onEdit(entry.node)}
                    className="text-xs px-2 py-0.5 rounded bg-bg-surface border border-border text-content-secondary hover:border-accent/40 transition-colors shrink-0"
                  >
                    Change
                  </button>
                  {isCross && t ? (
                    <>
                      <button
                        onClick={() => onAbsorb(entry.node, t.node.id)}
                        className="text-xs px-2 py-0.5 rounded bg-bg-surface border border-border text-content-secondary hover:border-accent/40 hover:text-accent transition-colors shrink-0"
                        title={`Move ${t.openingName}'s branches into this opening`}
                      >
                        Absorb
                      </button>
                      <button
                        onClick={() => onUnlink(entry.node)}
                        className="text-xs px-2 py-0.5 rounded bg-bg-surface border border-border text-content-secondary hover:border-danger/40 hover:text-danger transition-colors shrink-0"
                        title="Detach this cross-opening link; this node becomes the canonical here."
                      >
                        Unlink
                      </button>
                    </>
                  ) : (
                    <span
                      className="text-xs text-content-muted italic shrink-0"
                      title="Intra-opening links can't be detached — use Change to pick a different option."
                    >
                      intra
                    </span>
                  )}
                </div>
              );
            })}
          </li>
        );
      })}
    </ul>
  );
}

const MoveButton = memo(function MoveButton({ node, selected, onSelect, onContextMenu, forceNumber }: {
  node: Node;
  selected: boolean;
  onSelect: (n: Node) => void;
  onContextMenu: (e: React.MouseEvent, n: Node) => void;
  forceNumber: boolean;
}) {
  const prefix = movePrefix(node, forceNumber);
  const white = isWhiteMove(node);
  const linkTargets = useContext(LinkTargetsContext);
  const canonicalTargets = useContext(CanonicalTargetsContext);
  const { learned, userColor, learnableMap } = useContext(LearnedContext);
  const isCanonical = canonicalTargets.has(node.id);
  // This node is a "prompt" if its position is what the user studies to recall
  // their next move — i.e. one of its children is a learnable, unlearned user move.
  const isPrompt = userColor !== null && (node.children ?? []).some((c) => {
    const cSide = c.fen.split(' ')[1] === 'w' ? 'white' : 'black';
    const cIsUserMove = cSide !== userColor && c.move_san !== null;
    return cIsUserMove && (learnableMap.get(c.id) ?? false) && !learned.has(c.id);
  });
  const isLink = !!node.transposes_to_node_id;
  const target = node.transposes_to_node_id ? linkTargets.get(node.transposes_to_node_id) : null;
  const isCrossLink = !!(target && target.openingId !== node.opening_id);
  const linkTitle = !isLink
    ? undefined
    : target
      ? isCrossLink
        ? `Links to ${target.openingName} (${moveSanWithNumber(target.node)})`
        : `Links to a transposition elsewhere in this opening (${moveSanWithNumber(target.node)})`
      : 'Transposition link';

  return (
    <span className="inline-flex items-baseline" data-node-id={node.id}>
      {prefix && (
        <span className="text-content-muted text-xs font-mono mr-0.5 select-none">{prefix}</span>
      )}
      <button
        onClick={() => onSelect(node)}
        onContextMenu={(e) => onContextMenu(e, node)}
        title={linkTitle}
        className={[
          'px-1.5 py-0.5 rounded-md text-sm font-mono transition-all inline-flex items-baseline gap-0.5',
          selected
            ? 'bg-gold/20 text-gold ring-1 ring-gold/40'
            : white
              ? 'text-content-primary hover:bg-bg-elevated'
              : 'text-content-secondary hover:bg-bg-elevated',
        ].join(' ')}
      >
        {isPrompt && (
          <span
            aria-hidden
            title="Study this position — next move not yet learned"
            className="text-gold text-[0.55em] leading-none self-center mr-0.5"
          >
            ●
          </span>
        )}
        <span>{node.move_san}</span>
        {isLink && (
          <span
            aria-hidden
            className={[
              'text-[0.7em] leading-none translate-y-[-1px]',
              isCrossLink ? 'text-accent' : 'text-gold/80',
            ].join(' ')}
          >
            ⇄
          </span>
        )}
        {isCanonical && (
          <span
            aria-hidden
            title="Other moves link to this position"
            className="text-[0.6em] leading-none translate-y-[-1px] text-gold/60"
          >
            ◆
          </span>
        )}
      </button>
    </span>
  );
});
