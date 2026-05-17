/**
 * Colors reference CSS variables set at runtime by ThemeProvider
 * (apps/expo/hooks/useColorTheme.ts) using NativeWind's vars().
 * The `<alpha-value>` placeholder lets utilities like `bg-accent/15` work.
 */
const withVar = (name) => `rgb(var(--color-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
    './hooks/**/*.{js,ts,jsx,tsx}',
  ],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        bg: {
          base:     withVar('bg-base'),
          surface:  withVar('bg-surface'),
          elevated: withVar('bg-elevated'),
        },
        content: {
          primary:   withVar('content-primary'),
          secondary: withVar('content-secondary'),
          muted:     withVar('content-muted'),
        },
        accent: {
          DEFAULT: withVar('accent'),
          hover:   withVar('accent-hover'),
          dim:     withVar('accent-dim'),
        },
        gold: {
          DEFAULT: withVar('gold'),
          dim:     withVar('gold-dim'),
        },
        border: {
          DEFAULT: withVar('border'),
          subtle:  withVar('border-subtle'),
        },
        danger:  withVar('danger'),
        success: withVar('success'),
      },
    },
  },
  plugins: [],
};
