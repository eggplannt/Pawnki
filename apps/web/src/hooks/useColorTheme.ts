import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { palettes, hexToRgbChannels, type ColorTheme } from '@pawntree/shared';

export type { ColorTheme };

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'pawntree-theme';

function getInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Flatten palette object → CSS custom property entries with rgb channels.
 *  { bg: { base: '#fff' } }         → { '--color-bg-base': '255 255 255' }
 *  { accent: { DEFAULT: '#0f0' } }  → { '--color-accent': '0 255 0' }
 */
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

/** Apply palette as CSS custom properties on :root so Tailwind `var()` refs work. */
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

/** Read a CSS custom property and reassemble as an `rgb(...)` color.
 *  Vars are stored as "r g b" channels (for alpha composition in Tailwind);
 *  raw consumers (SVGs, chart libs) need a real color string. */
function cssVar(name: string): string {
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return channels ? `rgb(${channels})` : '';
}

/** Returns the current resolved color values (for third-party components). */
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
  toggleTheme: () => void;
  colors: ColorTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export { ThemeContext };

export function useThemeProvider() {
  const [theme, setTheme] = useState<Theme>(() => {
    const t = getInitialTheme();
    applyTheme(t); // apply immediately so CSS vars are set before first paint
    return t;
  });
  const [colors, setColors] = useState<ColorTheme>(getColorValues);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(STORAGE_KEY, theme);
    requestAnimationFrame(() => setColors(getColorValues()));
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggleTheme, colors };
}

export function useColorTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useColorTheme must be used within ThemeProvider');
  return ctx;
}
