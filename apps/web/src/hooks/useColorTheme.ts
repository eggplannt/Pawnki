import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { palettes, hexToRgbChannels, type ColorTheme } from '@pawntree/shared';

export type { ColorTheme };

export type ThemePref = 'light' | 'dark' | 'system';
type Theme = 'light' | 'dark';

const STORAGE_KEY = 'pawntree-theme';

function getSystemScheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function getInitialPref(): ThemePref {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

function flattenToCssVars(obj: Record<string, unknown>, prefix = '--color'): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const varName = key === 'DEFAULT' ? prefix : `${prefix}-${key}`;
    if (typeof value === 'string') {
      result[varName] = hexToRgbChannels(value);
    } else {
      Object.assign(result, flattenToCssVars(value as Record<string, unknown>, varName));
    }
  }
  return result;
}

function applyPalette(palette: Record<string, unknown>) {
  const cssVars = flattenToCssVars(palette);
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(cssVars)) {
    root.setProperty(name, value);
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'light') {
    root.classList.add('light');
  } else {
    root.classList.remove('light');
  }
  applyPalette(palettes[theme] as unknown as Record<string, unknown>);
}

function cssVar(name: string): string {
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return channels ? `rgb(${channels})` : '';
}

export function getColorValues(): ColorTheme {
  return {
    bg: {
      base:     cssVar('--color-bg-base'),
      surface:  cssVar('--color-bg-surface'),
      elevated: cssVar('--color-bg-elevated'),
    },
    content: {
      primary:   cssVar('--color-content-primary'),
      secondary: cssVar('--color-content-secondary'),
      muted:     cssVar('--color-content-muted'),
    },
    accent: {
      default: cssVar('--color-accent'),
      hover:   cssVar('--color-accent-hover'),
      dim:     cssVar('--color-accent-dim'),
    },
    gold: {
      default: cssVar('--color-gold'),
      dim:     cssVar('--color-gold-dim'),
    },
    border: {
      default: cssVar('--color-border'),
      subtle:  cssVar('--color-border-subtle'),
    },
    danger:  cssVar('--color-danger'),
    success: cssVar('--color-success'),
    board: {
      dark:  cssVar('--color-board-dark'),
      light: cssVar('--color-board-light'),
    },
  };
}

interface ThemeContextValue {
  theme: Theme;
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  toggleTheme: () => void;
  colors: ColorTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export { ThemeContext };

export function useThemeProvider() {
  const [pref, setPrefState] = useState<ThemePref>(() => {
    const p = getInitialPref();
    applyTheme(p === 'system' ? getSystemScheme() : p);
    return p;
  });
  const [systemScheme, setSystemScheme] = useState<Theme>(getSystemScheme);
  const [colors, setColors] = useState<ColorTheme>(getColorValues);

  // Track OS-level theme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = (e: MediaQueryListEvent) => setSystemScheme(e.matches ? 'light' : 'dark');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const theme: Theme = pref === 'system' ? systemScheme : pref;

  useEffect(() => {
    applyTheme(theme);
    requestAnimationFrame(() => setColors(getColorValues()));
  }, [theme]);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    localStorage.setItem(STORAGE_KEY, p);
  }, []);

  const toggleTheme = useCallback(() => {
    setPref(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setPref]);

  return { theme, pref, setPref, toggleTheme, colors };
}

export function useColorTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useColorTheme must be used within ThemeProvider');
  return ctx;
}
