import palettesJson from './colors.json';

export const palettes = palettesJson;

export function hexToRgbChannels(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

export interface ColorTheme {
  bg: { base: string; surface: string; elevated: string };
  content: { primary: string; secondary: string; muted: string };
  accent: { default: string; hover: string; dim: string };
  gold: { default: string; dim: string };
  border: { default: string; subtle: string };
  danger: string;
  success: string;
  board: { dark: string; light: string };
}

// Board palettes — the chess squares, independent from the app theme.
export const boardPalettes = {
  wood:  { dark: '#8a7355', light: '#dcc8a0', label: 'Wood' },
  slate: { dark: '#697785', light: '#c4cad0', label: 'Slate' },
  green: { dark: '#769656', light: '#eeeed2', label: 'Green' },
} as const;

export type BoardPaletteKey = keyof typeof boardPalettes;
export const DEFAULT_BOARD_PALETTE: BoardPaletteKey = 'wood';
export const BOARD_PALETTE_KEYS: BoardPaletteKey[] = ['wood', 'slate', 'green'];
