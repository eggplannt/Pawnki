import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  type ListRenderItemInfo,
} from 'react-native';
import type { Node } from '@/types';
import { colorTheme } from '@/hooks/useColorTheme';

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
  onSelect: (id: string) => void;
  onLongPress?: (id: string) => void;
}

const MoveCell = memo(function MoveCell({
  id, san, isWhite, selected, linkKind, onSelect, onLongPress,
}: MoveCellProps) {
  const handlePress = useCallback(() => onSelect(id), [onSelect, id]);
  const handleLongPress = useCallback(() => onLongPress?.(id), [onLongPress, id]);
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
  onSelect: (id: string) => void;
  onLongPress?: (id: string) => void;
}

const Row = memo(function Row({
  row, whiteSelected, blackSelected, whiteLinkKind, blackLinkKind, onSelect, onLongPress,
}: RowProps) {
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
          onSelect={onSelect}
          onLongPress={onLongPress}
        />
      )}
    </View>
  );
});

// ── MoveList ─────────────────────────────────────────────────────────────

interface MoveListProps {
  root: Node;
  selectedId: string | null;
  /** Map of node id → kind of link. Nodes not in the map are unlinked. */
  linkKinds?: Map<string, 'intra' | 'cross'>;
  onSelect: (id: string) => void;
  onLongPress?: (id: string) => void;
}

export const MoveList = memo(function MoveList({
  root, selectedId, linkKinds, onSelect, onLongPress,
}: MoveListProps) {
  const rows = useMemo(() => flattenTree(root), [root]);

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
    ({ item }: ListRenderItemInfo<MoveRow>) => (
      <Row
        row={item}
        whiteSelected={!!item.whiteId && item.whiteId === selectedId}
        blackSelected={!!item.blackId && item.blackId === selectedId}
        whiteLinkKind={item.whiteId ? (linkKinds?.get(item.whiteId) ?? 'none') : 'none'}
        blackLinkKind={item.blackId ? (linkKinds?.get(item.blackId) ?? 'none') : 'none'}
        onSelect={onSelect}
        onLongPress={onLongPress}
      />
    ),
    [selectedId, onSelect, onLongPress, linkKinds],
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
      contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
      onScrollToIndexFailed={(info) => {
        // Item isn't laid out yet — fall back to an estimated offset then retry.
        setTimeout(() => {
          listRef.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
          setTimeout(() => {
            try {
              listRef.current?.scrollToIndex({
                index: info.index,
                animated: true,
                viewPosition: 0.3,
              });
            } catch {}
          }, 50);
        }, 50);
      }}
    />
  );
});
