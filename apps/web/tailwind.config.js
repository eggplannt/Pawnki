/**
 * Colors reference CSS variables set at runtime by useColorTheme.
 * Each var holds "r g b" channels so utilities like `bg-accent/15`
 * can compose alpha via the <alpha-value> placeholder.
 */
const withVar = (name) => `rgb(var(--color-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/shared/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      keyframes: {
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%, 60%': { transform: 'translateX(-6px)' },
          '40%, 80%': { transform: 'translateX(6px)' },
        },
      },
      animation: {
        shake: 'shake 0.35s ease-in-out',
      },
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
        board: {
          dark:  withVar('board-dark'),
          light: withVar('board-light'),
        },
      },
    },
  },
  plugins: [],
};
