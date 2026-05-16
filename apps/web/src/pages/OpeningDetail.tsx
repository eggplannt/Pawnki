import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { AppShell } from '@/components/AppShell';
import {
  getOpening, getNodes, buildTree,
  createNode, deleteSubtree, updateNodeAnnotation,
  findTransposition, findIntraOpeningTransposition,
  importPgnToOpening,
  type ImportProgress,
} from '@/lib/openings';
import { useColorTheme } from '@/hooks/useColorTheme';
import type { Opening, Node } from '@/types';

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

function findNodeById(root: Node, id: string): Node | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return null;
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

// ── Main Component ──────────────────────────────────────────────────────────

export default function OpeningDetail() {
  const { id } = useParams<{ id: string }>();
  const [opening, setOpening] = useState<Opening | null>(null);
  const [tree, setTree] = useState<Node | null>(null);
  const [currentNode, setCurrentNode] = useState<Node | null>(null);
  const [forwardStack, setForwardStack] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const moveListRef = useRef<HTMLDivElement>(null);
  const { colors } = useColorTheme();

  const [saving, setSaving] = useState(false);
  const [pendingFen, setPendingFen] = useState<string | null>(null);
  const [highlightSquares, setHighlightSquares] = useState<Record<string, React.CSSProperties>>({});

  const [editingAnnotation, setEditingAnnotation] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState('');

  const [transpositionInfo, setTranspositionInfo] = useState<{
    type: 'cross-opening';
    openingName: string;
    openingId: string;
  } | {
    type: 'intra-opening';
    moveSan: string | null;
  } | null>(null);

  const [showPgnImport, setShowPgnImport] = useState(false);
  const [pgnText, setPgnText] = useState('');
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: Node } | null>(null);

  const parentMap = useMemo(() => (tree ? buildParentMap(tree) : new Map<string, Node>()), [tree]);

  useEffect(() => {
    if (!id) return;
    loadData(id);
  }, [id]);

  async function loadData(openingId: string, navigateToId?: string) {
    setLoading(true);
    try {
      const [o, nodes] = await Promise.all([getOpening(openingId), getNodes(openingId)]);
      setOpening(o);
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
    if (!currentNode) return;
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
  }, [currentNode, forwardStack, parentMap]);

  const goPrev = useCallback(() => {
    if (!currentNode || !parentMap.has(currentNode.id)) return;
    setForwardStack((prev) => [...prev, currentNode]);
    setCurrentNode(parentMap.get(currentNode.id)!);
  }, [currentNode, parentMap]);

  // ── Delete ───────────────────────────────────────────────────────────────

  const handleDeleteNode = useCallback(async (nodeToDelete?: Node) => {
    const target = nodeToDelete ?? currentNode;
    if (!target || !id || !parentMap.has(target.id)) return;
    const parentId = parentMap.get(target.id)!.id;
    setSaving(true);
    try {
      await deleteSubtree(target.id, id);
      await reloadTree(parentId);
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

  const handlePieceDrag = useCallback(({ square }: { isSparePiece: boolean; piece: { pieceType: string }; square: string | null }) => {
    if (!currentNode || !square) { setHighlightSquares({}); return; }
    const targets = getLegalMoveSquares(currentNode.fen, square);
    const styles: Record<string, React.CSSProperties> = {};
    styles[square] = { backgroundColor: colors.accent.dim, opacity: 0.6 };
    const chess = new Chess(currentNode.fen);
    for (const target of targets) {
      const isCapture = chess.get(target as any);
      styles[target] = isCapture
        ? { background: `radial-gradient(circle, transparent 55%, ${colors.accent.default} 55%, ${colors.accent.default} 68%, transparent 68%)` }
        : { background: `radial-gradient(circle, ${colors.accent.default} 25%, transparent 25%)`, opacity: 0.8 };
    }
    setHighlightSquares(styles);
  }, [currentNode, colors]);

  // ── Board interaction ────────────────────────────────────────────────────

  const handlePieceDrop = useCallback(({ sourceSquare, targetSquare }: {
    piece: unknown;
    sourceSquare: string;
    targetSquare: string | null;
  }): boolean => {
    setHighlightSquares({});
    if (!currentNode || !id || saving || !targetSquare) return false;

    const chess = new Chess(currentNode.fen);
    const result = chess.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
    if (!result) return false;

    const newFen = chess.fen();

    const existing = currentNode.children?.find((c) => c.fen === newFen);
    if (existing) {
      setCurrentNode(existing);
      setForwardStack([]);
      return true;
    }

    setPendingFen(newFen);

    const parentFen = currentNode.fen;
    const parentId = currentNode.id;
    setSaving(true);
    createNode(id, parentId, result.san, result.from + result.to + (result.promotion ?? ''), newFen)
      .then(async (newNode) => {
        await reloadTree(newNode.id);
        const intra = await findIntraOpeningTransposition(newFen, id, parentId);
        if (intra) {
          setTranspositionInfo({ type: 'intra-opening', moveSan: intra.moveSan });
          return;
        }
        const cross = await findTransposition(newFen, parentFen, id);
        if (cross) {
          setTranspositionInfo({ type: 'cross-opening', openingName: cross.openingName, openingId: cross.openingId });
        }
      })
      .finally(() => setSaving(false));

    return true;
  }, [currentNode, id, saving]);

  const canDragPiece = useCallback(({ piece }: { isSparePiece: boolean; piece: { pieceType: string }; square: string | null }): boolean => {
    if (!currentNode || saving) return false;
    const { isWhite } = fenInfo(currentNode.fen);
    return isWhite === (piece.pieceType[0] === 'w');
  }, [currentNode, saving]);

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
      await importPgnToOpening(id, pgnText, setImportProgress);
      await reloadTree(currentNode?.id);
      setShowPgnImport(false);
      setPgnText('');
      setImportProgress(null);
    } catch (err: any) {
      setImportError(err.message ?? 'Import failed');
    }
  }

  const handleMoveContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    if (!parentMap.has(node.id)) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, [parentMap]);

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
  const hasNext = !!(currentNode?.children?.length);
  const hasPrev = !!(currentNode && parentMap.has(currentNode.id));
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
            <span className={`text-lg shrink-0 ${opening.color === 'white' ? 'text-gold' : 'text-accent'}`}>
              {opening.color === 'white' ? '♔' : '♚'}
            </span>
            <h1 className="text-content-primary text-lg font-semibold truncate">{opening.name}</h1>
            {saving && (
              <div className="ml-auto w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
            )}
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
                  squareStyles: highlightSquares,
                  onPieceDrop: handlePieceDrop,
                  onPieceDrag: handlePieceDrag,
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
            <span className="text-accent text-xs">♟</span>
            <h2 className="text-content-secondary text-xs font-medium uppercase tracking-wider">Moves</h2>
            <button
              onClick={() => { setShowPgnImport(true); setImportError(null); setPgnText(''); setImportProgress(null); }}
              className="ml-auto text-xs text-accent hover:text-accent-hover transition-colors"
              title="Import/Merge PGN"
            >
              Import/Merge PGN
            </button>
          </div>
          <div ref={moveListRef} className="flex-1 overflow-y-auto overflow-x-hidden p-3 pb-14 min-h-0">
            <MoveTree
              root={tree}
              selected={currentNode}
              highlightColor={colors.gold.default}
              onSelect={selectNode}
              onContextMenu={handleMoveContextMenu}
            />
          </div>
          {/* Floating delete button */}
          {!isRoot && (
            <button
              onClick={() => handleDeleteNode()}
              disabled={saving}
              className="absolute bottom-3 right-3 w-9 h-9 flex items-center justify-center rounded-full bg-danger text-white hover:brightness-110 transition-all shadow-lg disabled:opacity-50"
              title="Delete selected move (Delete)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
              </svg>
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
            onClick={() => { handleDeleteNode(contextMenu.node); }}
            className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-bg-surface transition-colors"
          >
            Delete subtree
          </button>
        </div>
      )}

      {/* ── Transposition modal ── */}
      {transpositionInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setTranspositionInfo(null)}>
          <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-content-primary font-semibold mb-2">Transposition detected</h3>
            <p className="text-content-secondary text-sm mb-4">
              {transpositionInfo.type === 'cross-opening'
                ? <>This position also appears in <span className="text-accent font-medium">{transpositionInfo.openingName}</span>.</>
                : <>This position can also be reached via a different move order in this opening.</>
              }
            </p>
            <button
              onClick={() => setTranspositionInfo(null)}
              className="w-full py-2 rounded-lg bg-accent/15 text-accent font-medium text-sm hover:bg-accent/25 transition-colors"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* ── PGN import modal ── */}
      {showPgnImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !importProgress && setShowPgnImport(false)}>
          <div className="bg-bg-elevated border border-border rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-content-primary font-semibold mb-3">Import/Merge PGN</h3>
            <p className="text-content-muted text-xs mb-2">
              Paste PGN text below. Moves will be merged into the existing tree.
            </p>
            <textarea
              value={pgnText}
              onChange={(e) => setPgnText(e.target.value)}
              placeholder="1. e4 e5 2. Nf3 Nc6..."
              className="w-full h-40 bg-bg-surface border border-border rounded-lg px-3 py-2 text-content-primary text-sm font-mono resize-none outline-none focus:border-accent/40 transition-colors"
              disabled={!!importProgress}
            />
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

function MoveButton({ node, selected, onSelect, onContextMenu, forceNumber }: {
  node: Node;
  selected: boolean;
  onSelect: (n: Node) => void;
  onContextMenu: (e: React.MouseEvent, n: Node) => void;
  forceNumber: boolean;
}) {
  const prefix = movePrefix(node, forceNumber);
  const white = isWhiteMove(node);

  return (
    <span className="inline-flex items-baseline" data-node-id={node.id}>
      {prefix && (
        <span className="text-content-muted text-xs font-mono mr-0.5 select-none">{prefix}</span>
      )}
      <button
        onClick={() => onSelect(node)}
        onContextMenu={(e) => onContextMenu(e, node)}
        className={[
          'px-1.5 py-0.5 rounded-md text-sm font-mono transition-all',
          selected
            ? 'bg-gold/20 text-gold ring-1 ring-gold/40'
            : white
              ? 'text-content-primary hover:bg-bg-elevated'
              : 'text-content-secondary hover:bg-bg-elevated',
        ].join(' ')}
      >
        {node.move_san}
      </button>
    </span>
  );
}
