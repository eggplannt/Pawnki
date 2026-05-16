import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  InteractionManager,
  Modal,
  TextInput,
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  getNodes, buildTree,
  createNode, deleteSubtree, updateNodeAnnotation,
  findTransposition, findIntraOpeningTransposition,
  importPgnToOpening,
  type ImportProgress,
} from '@/lib/openings';
import { Chessboard, type ChessboardMove } from '@/components/Chessboard';
import { colorTheme } from '@/hooks/useColorTheme';
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

// ── Main Component ──────────────────────────────────────────────────────────

export default function OpeningDetailScreen() {
  const params = useLocalSearchParams<{ id: string; name?: string; color?: string }>();
  const id = params.id;
  const router = useRouter();
  const { width: screenWidth } = useWindowDimensions();

  const [opening] = useState<Opening>(() => ({
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
  const moveListRef = useRef<ScrollView>(null);

  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState('');

  const [pgnOpen, setPgnOpen] = useState(false);
  const [pgnText, setPgnText] = useState('');
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [transpositionInfo, setTranspositionInfo] = useState<
    | { type: 'cross-opening'; openingName: string; openingId: string }
    | { type: 'intra-opening'; moveSan: string | null }
    | null
  >(null);

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

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setTreeReady(false);
      try {
        const nodes = await getNodes(id);
        if (cancelled) return;
        const t = buildTree(nodes);
        setTree(t);
        setCurrentNode(t);
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
  }, [id]);

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

    // If an existing child already has this position, just navigate
    const existing = currentNode.children?.find((c) => c.fen === newFen);
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

      const intra = await findIntraOpeningTransposition(newFen, id, parentId);
      if (intra) {
        setTranspositionInfo({ type: 'intra-opening', moveSan: intra.moveSan });
      } else {
        const cross = await findTransposition(newFen, parentFen, id);
        if (cross) {
          setTranspositionInfo({ type: 'cross-opening', openingName: cross.openingName, openingId: cross.openingId });
        }
      }
    } finally {
      setSaving(false);
    }
  }, [currentNode, id, saving, reloadTree]);

  // ── Delete ───────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async () => {
    if (!currentNode || !id || !parentMap.has(currentNode.id)) return;
    const parentId = parentMap.get(currentNode.id)!.id;
    setSaving(true);
    try {
      await deleteSubtree(currentNode.id, id);
      await reloadTree(parentId);
    } finally {
      setSaving(false);
    }
  }, [currentNode, id, parentMap, reloadTree]);

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
      await importPgnToOpening(id, pgnText, setImportProgress);
      await reloadTree(currentNode?.id);
      setPgnOpen(false);
      setPgnText('');
      setImportProgress(null);
    } catch (err: any) {
      setImportError(err?.message ?? 'Import failed');
    }
  }, [id, pgnText, currentNode?.id, reloadTree]);

  // ── Auto-scroll selected move ────────────────────────────────────────────

  const selectedId = currentNode?.id ?? null;
  const movePositions = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!selectedId || !treeReady) return;
    const y = movePositions.current.get(selectedId);
    if (y !== undefined) {
      moveListRef.current?.scrollTo({ y: Math.max(0, y - 80), animated: true });
    }
  }, [selectedId, treeReady]);

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
  const hasNext = !!(currentNode?.children?.length);
  const hasPrev = !!(currentNode && parentMap.has(currentNode.id));
  const isRoot = currentNode === tree;

  return (
    <SafeAreaView className="flex-1 bg-bg-base">
      {/* Header */}
      <View className="flex-row items-center gap-2 px-4 py-2">
        <Pressable
          onPress={() => router.back()}
          className="w-8 h-8 items-center justify-center rounded-lg active:bg-bg-elevated"
        >
          <Text className="text-content-muted text-lg">←</Text>
        </Pressable>
        <Text className={`text-lg ${isWhite ? 'text-gold' : 'text-accent'}`}>
          {isWhite ? '♔' : '♚'}
        </Text>
        <Text className="text-content-primary text-base font-semibold flex-1" numberOfLines={1}>
          {opening.name}
        </Text>
        {saving && <ActivityIndicator size="small" color={colorTheme.accent.default} />}
        <Pressable
          onPress={() => { setPgnText(''); setImportError(null); setImportProgress(null); setPgnOpen(true); }}
          className="px-2 py-1 rounded-md active:bg-bg-elevated"
        >
          <Text className="text-accent text-xs">PGN</Text>
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
          />
        </View>
      </View>

      {/* Nav controls */}
      <View className="flex-row items-center justify-center gap-2 py-2">
        <NavButton onPress={goToStart} disabled={!hasPrev} label="⏮" />
        <NavButton onPress={goPrev} disabled={!hasPrev} label="◀" />
        <NavButton onPress={goNext} disabled={!hasNext} label="▶" />
        <NavButton onPress={goToEnd} disabled={!hasNext} label="⏭" />
      </View>

      {/* Current move + annotation */}
      {currentNode?.move_san && (
        <View className="px-4 py-1">
          <Text className="text-gold text-base font-semibold text-center">
            {movePrefix(currentNode, true)}{currentNode.move_san}
          </Text>
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

      {/* Move tree */}
      <View className="flex-1 border-t border-border mt-1">
        <View className="flex-row items-center gap-2 px-4 py-2 border-b border-border">
          <Text className="text-accent text-xs">♟</Text>
          <Text className="text-content-secondary text-xs font-medium uppercase tracking-wider flex-1">
            Moves
          </Text>
          {!isRoot && (
            <Pressable
              onPress={handleDelete}
              disabled={saving}
              className="px-2 py-1 rounded-md bg-danger/15 active:bg-danger/25"
            >
              <Text className="text-danger text-xs font-medium">Delete</Text>
            </Pressable>
          )}
        </View>
        {treeReady ? (
          <ScrollView ref={moveListRef} className="flex-1 p-3">
            <MoveTree
              root={tree}
              selectedId={selectedId}
              onSelect={selectNode}
              onLayoutMove={(nodeId, y) => movePositions.current.set(nodeId, y)}
            />
          </ScrollView>
        ) : (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="small" color={colorTheme.accent.default} />
          </View>
        )}
      </View>

      {/* Transposition modal */}
      <Modal
        visible={!!transpositionInfo}
        transparent
        animationType="fade"
        onRequestClose={() => setTranspositionInfo(null)}
      >
        <Pressable
          className="flex-1 items-center justify-center px-6"
          style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
          onPress={() => setTranspositionInfo(null)}
        >
          <Pressable className="bg-bg-elevated border border-border rounded-xl p-6 w-full max-w-sm" onPress={() => {}}>
            <Text className="text-content-primary font-semibold text-base mb-2">Transposition detected</Text>
            <Text className="text-content-secondary text-sm mb-4">
              {transpositionInfo?.type === 'cross-opening'
                ? `This position also appears in ${transpositionInfo.openingName}.`
                : 'This position can also be reached via a different move order in this opening.'}
            </Text>
            <Pressable
              onPress={() => setTranspositionInfo(null)}
              className="py-2 rounded-lg bg-accent/15 active:bg-accent/25 items-center"
            >
              <Text className="text-accent font-medium text-sm">OK</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Annotation editor modal */}
      <Modal
        visible={annotationOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAnnotationOpen(false)}
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
      </Modal>

      {/* PGN import modal */}
      <Modal
        visible={pgnOpen}
        transparent
        animationType="fade"
        onRequestClose={() => !importProgress && setPgnOpen(false)}
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
      </Modal>
    </SafeAreaView>
  );
}

const NavButton = memo(function NavButton({
  onPress, disabled, label,
}: {
  onPress: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={[
        'w-12 h-10 items-center justify-center rounded-xl bg-bg-surface border border-border',
        disabled ? 'opacity-30' : 'active:bg-accent/5 active:border-accent/40',
      ].join(' ')}
    >
      <Text className={disabled ? 'text-content-muted' : 'text-content-secondary'}>
        {label}
      </Text>
    </Pressable>
  );
});

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

const MoveTree = memo(function MoveTree({
  root, selectedId, onSelect, onLayoutMove,
}: {
  root: Node;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLayoutMove: (id: string, y: number) => void;
}) {
  if (!root.children?.length) {
    return <Text className="text-content-muted text-sm">No moves yet. Tap a piece on the board.</Text>;
  }
  return <MoveLine nodes={root.children} selectedId={selectedId} onSelect={onSelect} onLayoutMove={onLayoutMove} />;
});

const MoveLine = memo(function MoveLine({
  nodes, selectedId, onSelect, onLayoutMove,
}: {
  nodes: Node[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLayoutMove: (id: string, y: number) => void;
}) {
  if (nodes.length === 0) return null;
  const [main, ...alts] = nodes;
  const mainRun = collectMainRun(main);
  const lastInRun = mainRun[mainRun.length - 1];
  const branchesAfterRun = lastInRun.children ?? [];

  return (
    <>
      <View className="flex-row flex-wrap items-baseline" style={{ gap: 2 }}>
        {mainRun.map((node, i) => (
          <MoveButton
            key={node.id}
            node={node}
            selected={selectedId === node.id}
            onSelect={onSelect}
            onLayoutMove={onLayoutMove}
            forceNumber={i === 0}
          />
        ))}
      </View>

      {alts.map((alt) => (
        <VariationBlock
          key={alt.id}
          node={alt}
          selectedId={selectedId}
          onSelect={onSelect}
          onLayoutMove={onLayoutMove}
        />
      ))}

      {branchesAfterRun.length > 0 && (
        <MoveLine nodes={branchesAfterRun} selectedId={selectedId} onSelect={onSelect} onLayoutMove={onLayoutMove} />
      )}
    </>
  );
});

const VariationBlock = memo(function VariationBlock({
  node, selectedId, onSelect, onLayoutMove,
}: {
  node: Node;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onLayoutMove: (id: string, y: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const run = collectMainRun(node);
  const lastInRun = run[run.length - 1];
  const branchesAfterRun = lastInRun.children ?? [];
  const isLong = run.length > 4 || branchesAfterRun.length > 0;

  return (
    <View
      className="my-0.5 ml-1 pl-2"
      style={{ borderLeftWidth: 2, borderLeftColor: colorTheme.gold.dim + '40' }}
    >
      <View className="flex-row flex-wrap items-baseline" style={{ gap: 2 }}>
        {isLong && (
          <Pressable onPress={() => setCollapsed(!collapsed)} className="mr-0.5">
            <Text className="text-accent/50 text-xs">{collapsed ? '▶' : '▼'}</Text>
          </Pressable>
        )}
        {collapsed ? (
          <>
            <MoveButton
              node={run[0]}
              selected={selectedId === run[0].id}
              onSelect={onSelect}
              onLayoutMove={onLayoutMove}
              forceNumber
            />
            <Text className="text-content-muted text-xs">...</Text>
          </>
        ) : (
          run.map((n, i) => (
            <MoveButton
              key={n.id}
              node={n}
              selected={selectedId === n.id}
              onSelect={onSelect}
              onLayoutMove={onLayoutMove}
              forceNumber={i === 0}
            />
          ))
        )}
      </View>

      {!collapsed && branchesAfterRun.length > 0 && (
        <MoveLine nodes={branchesAfterRun} selectedId={selectedId} onSelect={onSelect} onLayoutMove={onLayoutMove} />
      )}
    </View>
  );
});

const MoveButton = memo(function MoveButton({
  node, selected, onSelect, onLayoutMove, forceNumber,
}: {
  node: Node;
  selected: boolean;
  onSelect: (id: string) => void;
  onLayoutMove: (id: string, y: number) => void;
  forceNumber: boolean;
}) {
  const prefix = movePrefix(node, forceNumber);
  const white = isWhiteMove(node);
  const handlePress = useCallback(() => onSelect(node.id), [onSelect, node.id]);

  return (
    <View
      className="flex-row items-baseline"
      onLayout={(e) => onLayoutMove(node.id, e.nativeEvent.layout.y)}
    >
      {prefix ? (
        <Text className="text-content-muted text-xs font-mono mr-0.5">{prefix}</Text>
      ) : null}
      <Pressable
        onPress={handlePress}
        className={[
          'px-1.5 py-0.5 rounded-md',
          selected ? 'bg-gold/20' : '',
        ].join(' ')}
        style={selected ? { borderWidth: 1, borderColor: colorTheme.gold.default + '60' } : undefined}
      >
        <Text
          className={[
            'text-sm font-mono',
            selected
              ? 'text-gold'
              : white
                ? 'text-content-primary'
                : 'text-content-secondary',
          ].join(' ')}
        >
          {node.move_san}
        </Text>
      </Pressable>
    </View>
  );
});
