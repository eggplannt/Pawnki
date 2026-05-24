import { Component, useMemo, useState, type ReactNode } from 'react';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { useColorTheme } from '@/hooks/useColorTheme';
import { legalTargetStyles } from '@/lib/board-highlights';

interface BoardErrorBoundaryProps { children: ReactNode; resetKey: string }
class BoardErrorBoundary extends Component<BoardErrorBoundaryProps, { errored: boolean }> {
  state = { errored: false };
  static getDerivedStateFromError() { return { errored: true }; }
  componentDidUpdate(prev: BoardErrorBoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.errored) this.setState({ errored: false });
  }
  render() {
    if (this.state.errored) return <div className="w-full h-full bg-bg-surface rounded-lg flex items-center justify-center text-content-muted text-sm">Board error</div>;
    return this.props.children;
  }
}

export function FreePlayBoard() {
  const { colors } = useColorTheme();
  const [chess] = useState(() => new Chess());
  const [fen, setFen] = useState(() => chess.fen());
  const [activeSquare, setActiveSquare] = useState<string | null>(null);

  const squareStyles = useMemo(() => {
    if (!activeSquare) return {};
    const legal = legalTargetStyles(fen, activeSquare, colors.accent.default);
    return {
      ...legal,
      [activeSquare]: {
        backgroundColor: 'rgb(var(--color-accent) / 0.5)',
        boxShadow: `inset 0 0 0 4px ${colors.accent.default}`,
      },
    };
  }, [activeSquare, fen, colors.accent.default]);

  function handlePieceDrop({ sourceSquare, targetSquare }: { piece: unknown; sourceSquare: string; targetSquare: string | null }): boolean {
    if (!targetSquare) return false;
    setActiveSquare(null);
    try {
      chess.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
      setFen(chess.fen());
      return true;
    } catch {
      return false;
    }
  }

  function handleSquareClick({ square, piece }: { square: string | null; piece: { pieceType: string } | null }) {
    if (!square) return;
    if (activeSquare) {
      if (square === activeSquare) { setActiveSquare(null); return; }
      try {
        chess.move({ from: activeSquare, to: square, promotion: 'q' });
        setFen(chess.fen());
        setActiveSquare(null);
        return;
      } catch {
        setActiveSquare(piece ? square : null);
        return;
      }
    }
    if (piece) setActiveSquare(square);
  }

  function handleReset() {
    chess.reset();
    setFen(chess.fen());
    setActiveSquare(null);
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 w-full h-full">
      <div
        style={{
          maxHeight: 'calc(100vh - 160px)',
          maxWidth: 'calc(100vh - 160px)',
          width: '100%',
          aspectRatio: '1 / 1',
        }}
      >
        <BoardErrorBoundary resetKey={fen}>
          <Chessboard
            options={{
              position: fen,
              animationDurationInMs: 150,
              boardStyle: { borderRadius: '8px', boxShadow: '0 4px 24px rgba(0,0,0,0.25)' },
              darkSquareStyle: { backgroundColor: colors.board.dark },
              lightSquareStyle: { backgroundColor: colors.board.light },
              squareStyles,
              dropSquareStyle: { backgroundColor: colors.accent.dim },
              onPieceDrop: handlePieceDrop,
              onPieceDrag: ({ square }: { square: string | null }) => { if (square) setActiveSquare(square); },
              onSquareClick: handleSquareClick,
            }}
          />
        </BoardErrorBoundary>
      </div>
      <button
        onClick={handleReset}
        className="text-xs text-content-muted hover:text-content-secondary transition-colors"
      >
        Reset board
      </button>
    </div>
  );
}
