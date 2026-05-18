import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  type ListRenderItemInfo,
} from 'react-native';
import type { Node } from '@pawnki/shared';
import { useColorTheme } from '@/hooks/useColorTheme';

// ── FEN helpers ──────────────────────────────────────────────────────────

function fenInfo(fen: string) {
  const parts = fen.split(' ');
  return { whiteToMove: parts[1] === 'w', moveNum: parseInt(parts[5] ?? '1', 10) };
}

function isWhiteMove(node: Node): boolean {
  // A node represents the move that LED to its FEN. If it's black's turn next,
  // the move just played was white's.
  return !fenInfo(node.fen).whiteToMove;
}

// ── Tree flattening ──────────────────────────────────────────────────────

/**
 * One renderable row in the flat list: a single move pair (white + black),
 * or a fragment (just white, or just black for variations starting on black's
 * move). `depth` controls indentation; `variationStart` shows the "..."
 * convention for variations that begin on a black move.
 */
interface MoveRow {
  key: string;
  depth: number;
  displayMoveNum: number;
  whiteId?: string;
  whiteSan?: string;
  blackId?: string;
  blackSan?: string;
  variationStart: boolean;
}

function walkLine(
  start: Node,
  depth: number,
  out: MoveRow[],
  startsOnBlack: boolean,
) {
  let current: Node | undefined = start;
  let buf: { white?: Node; black?: Node } | null = null;
  let isFirstRow = true;

  const flush = () => {
    if (!buf) return;
    const w = buf.white;
    const b = buf.black;
    const moveNum = w
      ? fenInfo(w.fen).moveNum
      : fenInfo(b!.fen).moveNum - 1;
    out.push({
      key: `${w?.id ?? '_'}-${b?.id ?? '_'}-${depth}`,
      depth,
      displayMoveNum: moveNum,
      whiteId: w?.id,
      whiteSan: w?.move_san ?? undefined,
      blackId: b?.id,
      blackSan: b?.move_san ?? undefined,
      variationStart: isFirstRow && startsOnBlack && !w,
    });
    isFirstRow = false;
    buf = null;
  };

  while (current) {
    if (isWhiteMove(current)) {
      flush();
      buf = { white: current };
    } else {
      if (buf) buf.black = current;
      else buf = { black: current };
    }

    const ch: Node[] = current.children ?? [];
    if (ch.length > 1) {
      flush();
      const main: Node = ch[0];
      const alts: Node[] = ch.slice(1);
      const altsAreBlack = !isWhiteMove(main);
      for (const alt of alts) walkLine(alt, depth + 1, out, altsAreBlack);
      current = main;
    } else if (ch.length === 1) {
      if (buf && buf.white && buf.black) flush();
      current = ch[0];
    } else {
      current = undefined;
    }
  }

  flush();
}

function flattenTree(root: Node): MoveRow[] {
  const out: MoveRow[] = [];
  const ch = root.children ?? [];
  if (ch.length === 0) return out;
  const [main, ...alts] = ch;
  const altsAreBlack = !isWhiteMove(main);
  walkLine(main, 0, out, false);
  for (const alt of alts) walkLine(alt, 1, out, altsAreBlack);
  return out;
}

// ── Cell ─────────────────────────────────────────────────────────────────

interface MoveCellProps {
  id: string;
  san: string;
  isWhite: boolean;
  selected: boolean;
  linkKind: 'none' | 'intra' | 'cross';
  /** Node is a canonical that other nodes link to. */
  isCanonical: boolean;
  /** This cell's resulting position is the prompt for an unlearned user move.
   *  Renders a strong gold treatment so it's clearly "study this position". */
  isPrompt: boolean;
  onSelect: (id: string) => void;
  onLongPress?: (id: string) => void;
}

const MoveCell = memo(function MoveCell({
  id, san, isWhite, selected, linkKind, isCanonical, isPrompt, onSelect, onLongPress,
}: MoveCellProps) {
  const { colors: colorTheme } = useColorTheme();
  const handlePress = useCallback(() => onSelect(id), [onSelect, id]);
  const handleLongPress = useCallback(() => onLongPress?.(id), [onLongPress, id]);
  const showPrompt = isPrompt && !selected;
  return (
    <Pressable
      onPress={handlePress}
      onLongPress={handleLongPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 6,
        paddingVertical: 2,
        marginRight: 4,
        borderRadius: 4,
        backgroundColor: selected ? colorTheme.gold.default + '33' : 'transparent',
        borderWidth: selected ? 1 : 0,
        borderColor: selected ? colorTheme.gold.default + '60' : 'transparent',
      }}
    >
      {showPrompt && (
        <Text
          style={{
            fontFamily: 'monospace',
            fontSize: 7,
            marginRight: 3,
            color: colorTheme.gold.default,
          }}
        >
          ●
        </Text>
      )}
      <Text
        style={{
          fontFamily: 'monospace',
          fontSize: 14,
          color: selected
            ? colorTheme.gold.default
            : isWhite
              ? colorTheme.content.primary
              : colorTheme.content.secondary,
        }}
      >
        {san}
      </Text>
      {linkKind !== 'none' && (
        <Text
          style={{
            fontSize: 10,
            marginLeft: 3,
            color: linkKind === 'cross' ? colorTheme.accent.default : colorTheme.gold.dim,
          }}
        >
          ⇄
        </Text>
      )}
      {isCanonical && (
        <Text
          style={{
            fontSize: 9,
            marginLeft: 3,
            color: colorTheme.gold.dim,
          }}
        >
          ◆
        </Text>
      )}
    </Pressable>
  );
});

// ── Row ──────────────────────────────────────────────────────────────────

interface RowProps {
  row: MoveRow;
  whiteSelected: boolean;
  blackSelected: boolean;
  whiteLinkKind: 'none' | 'intra' | 'cross';
  blackLinkKind: 'none' | 'intra' | 'cross';
  whiteIsPrompt: boolean;
  blackIsPrompt: boolean;
  whiteIsCanonical: boolean;
  blackIsCanonical: boolean;
  onSelect: (id: string) => void;
  onLongPress?: (id: string) => void;
}

const Row = memo(function Row({
  row, whiteSelected, blackSelected, whiteLinkKind, blackLinkKind, whiteIsPrompt, blackIsPrompt, whiteIsCanonical, blackIsCanonical, onSelect, onLongPress,
}: RowProps) {
  const { colors: colorTheme } = useColorTheme();
  const isVariation = row.depth > 0;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        paddingLeft: row.depth * 12,
        paddingVertical: 1,
        marginLeft: isVariation ? 4 : 0,
        borderLeftWidth: isVariation ? 2 : 0,
        borderLeftColor: colorTheme.gold.dim + '40',
      }}
    >
      <Text
        style={{
          fontFamily: 'monospace',
          fontSize: 12,
          color: colorTheme.content.muted,
          marginRight: 4,
          marginLeft: isVariation ? 4 : 0,
          minWidth: 28,
        }}
      >
        {row.displayMoveNum}.{row.variationStart ? '..' : ''}
      </Text>
      {row.whiteId && row.whiteSan && (
        <MoveCell
          id={row.whiteId}
          san={row.whiteSan}
          isWhite
          selected={whiteSelected}
          linkKind={whiteLinkKind}
          isPrompt={whiteIsPrompt}
          isCanonical={whiteIsCanonical}
          onSelect={onSelect}
          onLongPress={onLongPress}
        />
      )}
      {!row.whiteId && row.variationStart && (
        <Text
          style={{
            fontFamily: 'monospace',
            fontSize: 12,
            color: colorTheme.content.muted,
            marginRight: 4,
          }}
        >
          ...
        </Text>
      )}
      {row.blackId && row.blackSan && (
        <MoveCell
          id={row.blackId}
          san={row.blackSan}
          isWhite={false}
          selected={blackSelected}
          linkKind={blackLinkKind}
          isPrompt={blackIsPrompt}
          isCanonical={blackIsCanonical}
          onSelect={onSelect}
          onLongPress={onLongPress}
        />
      )}
    </View>
  );
});

// ── MoveList ─────────────────────────────────────────────────────────────

// Row height used by getItemLayout so scrollToIndex works without items being
// pre-rendered. Calculated as: row paddingVertical (2) + cell paddingVertical (4)
// + fontSize-14 line height (~20) = 26px.
const ITEM_HEIGHT = 26;

interface MoveListProps {
  root: Node;
  selectedId: string | null;
  /** Map of node id → kind of link. Nodes not in the map are unlinked. */
  linkKinds?: Map<string, 'intra' | 'cross'>;
  /** Set of node ids that are user-move nodes that have been learned. */
  learnedSet?: Set<string>;
  /** Set of node ids that are LEARNABLE user-moves (unique-response).
   *  Only learnable+unlearned moves get the warning indicator; branching
   *  positions get nothing. */
  learnableSet?: Set<string>;
  /** Opening color so we can decide which nodes are user-moves. */
  userColor?: 'white' | 'black';
  /** Set of node ids that are canonical targets of link nodes (show ◆). */
  canonicalIds?: Set<string>;
  onSelect: (id: string) => void;
  onLongPress?: (id: string) => void;
}

export const MoveList = memo(function MoveList({
  root, selectedId, linkKinds, learnedSet, learnableSet, userColor, canonicalIds, onSelect, onLongPress,
}: MoveListProps) {
  const { colors: colorTheme } = useColorTheme();
  const rows = useMemo(() => flattenTree(root), [root]);

  // Opponent-move ids whose immediate user-move child is learnable + unlearned.
  // The opponent move is the position the user studies to recall their reply.
  const promptSet = useMemo(() => {
    const out = new Set<string>();
    if (!userColor || !learnableSet) return out;
    const ls = learnableSet;
    function walk(n: Node) {
      for (const c of n.children ?? []) {
        const childIsUserMove = isWhiteMove(c) ? userColor === 'white' : userColor === 'black';
        if (childIsUserMove && ls.has(c.id) && !learnedSet?.has(c.id)) {
          out.add(n.id);
        }
        walk(c);
      }
    }
    walk(root);
    return out;
  }, [root, learnableSet, learnedSet, userColor]);

  const idToIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => {
      if (r.whiteId) m.set(r.whiteId, i);
      if (r.blackId) m.set(r.blackId, i);
    });
    return m;
  }, [rows]);

  const listRef = useRef<FlatList<MoveRow>>(null);

  // Scroll the selected move into view when it changes.
  useEffect(() => {
    if (!selectedId) return;
    const idx = idToIndex.get(selectedId);
    if (idx === undefined) return;
    try {
      listRef.current?.scrollToIndex({
        index: idx,
        animated: true,
        viewPosition: 0.3,
      });
    } catch {
      // ignore — scrollToIndexFailed handles non-laid-out items
    }
  }, [selectedId, idToIndex]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<MoveRow>) => {
      return (
        <Row
          row={item}
          whiteSelected={!!item.whiteId && item.whiteId === selectedId}
          blackSelected={!!item.blackId && item.blackId === selectedId}
          whiteLinkKind={item.whiteId ? (linkKinds?.get(item.whiteId) ?? 'none') : 'none'}
          blackLinkKind={item.blackId ? (linkKinds?.get(item.blackId) ?? 'none') : 'none'}
          whiteIsPrompt={!!item.whiteId && promptSet.has(item.whiteId)}
          blackIsPrompt={!!item.blackId && promptSet.has(item.blackId)}
          whiteIsCanonical={!!item.whiteId && !!canonicalIds?.has(item.whiteId)}
          blackIsCanonical={!!item.blackId && !!canonicalIds?.has(item.blackId)}
          onSelect={onSelect}
          onLongPress={onLongPress}
        />
      );
    },
    [selectedId, onSelect, onLongPress, linkKinds, promptSet, canonicalIds],
  );

  const keyExtractor = useCallback((item: MoveRow) => item.key, []);

  if (rows.length === 0) {
    return (
      <Text
        style={{
          color: colorTheme.content.muted,
          fontSize: 14,
          padding: 12,
        }}
      >
        No moves yet. Tap a piece on the board.
      </Text>
    );
  }

  return (
    <FlatList
      ref={listRef}
      data={rows}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      initialNumToRender={25}
      maxToRenderPerBatch={20}
      windowSize={10}
      removeClippedSubviews
      getItemLayout={(_, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
      contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
      onScrollToIndexFailed={(info) => {
        listRef.current?.scrollToOffset({
          offset: ITEM_HEIGHT * info.index,
          animated: false,
        });
      }}
    />
  );
});
