/** @type {import('tailwindcss').Config} */

// Every colour resolves through a CSS variable declared in index.css, so a
// single `data-theme` swap on <html> re-themes the whole app and no component
// needs a `dark:` variant of its own.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg:        token('bg'),
        surface:   token('surface'),
        'surface-2': token('surface-2'),
        'surface-3': token('surface-3'),
        elevated:  token('elevated'),
        line:      token('line'),
        ink:       token('ink'),
        'ink-2':   token('ink-2'),
        'ink-3':   token('ink-3'),
        accent:    token('accent'),
        'accent-ink': token('accent-ink'),
        info:      token('info'),
        danger:    token('danger'),
        success:   token('success'),
        ai:        token('ai'),
      },
      borderRadius: {
        xl: '14px',
        '2xl': '18px',
        '3xl': '24px',
      },
      boxShadow: {
        // Apple-ish: a tight contact shadow plus a wide soft one.
        pane: '0 1px 2px -1px rgb(var(--shadow) / 0.18), 0 8px 28px -10px rgb(var(--shadow) / 0.22)',
        pop:  '0 2px 6px -2px rgb(var(--shadow) / 0.2), 0 16px 48px -12px rgb(var(--shadow) / 0.32)',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      fontSize: {
        '2xs': ['10.5px', { lineHeight: '1.35' }],
      },
      // Tailwind only emits `bg-ink/N` for N in its opacity scale, and the
      // default scale skips most values. The tints this design leans on live
      // between 4% and 20%, so the scale is every whole percent — JIT still
      // only ships the ones actually used.
      opacity: Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [String(i), String(i / 100)])
      ),
    },
  },
  plugins: [],
}
