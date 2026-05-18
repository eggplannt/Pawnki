/**
 * Theme provider for Expo. Drives both NativeWind className colors (via CSS
 * vars applied at the root with `vars()`) and raw color values consumed by
 * SVGs / icons / inline styles (via `useColorTheme().colors`).
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { View, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { vars } from 'nativewind';
import {
  palettes,
  hexToRgbChannels,
  boardPalettes,
  DEFAULT_BOARD_PALETTE,
  type ColorTheme,
  type BoardPaletteKey,
} from '@pawntree/shared';

export type { ColorTheme, BoardPaletteKey };

type SchemeMode = 'light' | 'dark';
export type ThemePref = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'pawntree-theme-pref';
const BOARD_STORAGE_KEY = 'pawntree-board-theme';

function buildVars(palette: typeof palettes.dark) {
  return vars({
    '--color-bg-base':           hexToRgbChannels(palette.bg.base),
    '--color-bg-surface':        hexToRgbChannels(palette.bg.surface),
    '--color-bg-elevated':       hexToRgbChannels(palette.bg.elevated),
    '--color-content-primary':   hexToRgbChannels(palette.content.primary),
    '--color-content-secondary': hexToRgbChannels(palette.content.secondary),
    '--color-content-muted':     hexToRgbChannels(palette.content.muted),
    '--color-accent':            hexToRgbChannels(palette.accent.DEFAULT),
    '--color-accent-hover':      hexToRgbChannels(palette.accent.hover),
    '--color-accent-dim':        hexToRgbChannels(palette.accent.dim),
    '--color-gold':              hexToRgbChannels(palette.gold.DEFAULT),
    '--color-gold-dim':          hexToRgbChannels(palette.gold.dim),
    '--color-border':            hexToRgbChannels(palette.border.DEFAULT),
    '--color-border-subtle':     hexToRgbChannels(palette.border.subtle),
    '--color-danger':            hexToRgbChannels(palette.danger),
    '--color-success':           hexToRgbChannels(palette.success),
  });
}

function buildColorTheme(palette: typeof palettes.dark, board: BoardPaletteKey): ColorTheme {
  const b = boardPalettes[board];
  return {
    bg: palette.bg,
    content: palette.content,
    accent: {
      default: palette.accent.DEFAULT,
      hover:   palette.accent.hover,
      dim:     palette.accent.dim,
    },
    gold: {
      default: palette.gold.DEFAULT,
      dim:     palette.gold.dim,
    },
    border: {
      default: palette.border.DEFAULT,
      subtle:  palette.border.subtle,
    },
    danger:  palette.danger,
    success: palette.success,
    board:   { dark: b.dark, light: b.light },
  };
}

interface ThemeContextValue {
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  scheme: SchemeMode;
  colors: ColorTheme;
  boardPref: BoardPaletteKey;
  setBoardPref: (b: BoardPaletteKey) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [pref, setPrefState] = useState<ThemePref>('system');
  const [boardPref, setBoardPrefState] = useState<BoardPaletteKey>(DEFAULT_BOARD_PALETTE);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((v) => {
      if (v === 'light' || v === 'dark' || v === 'system') setPrefState(v);
    });
    AsyncStorage.getItem(BOARD_STORAGE_KEY).then((v) => {
      if (v && v in boardPalettes) setBoardPrefState(v as BoardPaletteKey);
    });
  }, []);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    AsyncStorage.setItem(STORAGE_KEY, p).catch(() => {});
  };

  const setBoardPref = (b: BoardPaletteKey) => {
    setBoardPrefState(b);
    AsyncStorage.setItem(BOARD_STORAGE_KEY, b).catch(() => {});
  };

  const scheme: SchemeMode =
    pref === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : pref;

  const palette = scheme === 'light' ? palettes.light : palettes.dark;
  const themeStyle = useMemo(() => buildVars(palette), [scheme]);
  const colors = useMemo(() => buildColorTheme(palette, boardPref), [scheme, boardPref]);

  return (
    <ThemeContext.Provider value={{ pref, setPref, scheme, colors, boardPref, setBoardPref }}>
      <View style={[{ flex: 1 }, themeStyle]}>{children}</View>
    </ThemeContext.Provider>
  );
}

export function useColorTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useColorTheme must be used inside <ThemeProvider>');
  return ctx;
}
