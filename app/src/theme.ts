// Hermes mobile palettes.
//
// The colours are the desktop client's tokens from
// frontend/src/index.css — keep the two in step, or the phone and the desktop
// stop looking like the same product. The scales below (radius, spacing, type)
// mirror the same design language: generous corners, hairline separators, and
// a tight type ramp.
//
// This used to export a single frozen dark object, so the phone had no light
// mode at all while the desktop shipped a complete light palette. Both are
// here now and the active one is chosen at runtime — see ThemeContext.

export interface Palette {
  bg: string;
  bgElevated: string;
  bgAlt: string;
  bgInput: string;
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  danger: string;
  dangerSoft: string;
  success: string;
  info: string;
  ai: string;
  unread: string;
  /** A translucent wash for hover/pressed states over any surface. */
  wash: string;
  /** Backgrounds for the swipe actions revealed behind a list row. */
  swipeArchive: string;
  swipeDelete: string;
}

export const darkPalette: Palette = {
  bg: '#060609',          // --bg      page ground
  bgElevated: '#1b1b21',  // --surface  cards, headers
  bgAlt: '#141419',       // --surface-2
  bgInput: '#292931',     // --surface-3 fields, pressed states
  border: '#40404a',      // --line
  text: '#f2f2f7',        // --ink
  textMuted: '#9fa0ac',   // --ink-2
  textFaint: '#6f707d',   // --ink-3
  accent: '#fbbf24',      // --accent
  accentText: '#201500',  // ink on accent
  accentSoft: 'rgba(251, 191, 36, 0.16)',
  danger: '#ff635c',      // --danger
  dangerSoft: 'rgba(255, 99, 92, 0.14)',
  success: '#30c75f',     // --success
  info: '#0a84ff',        // --info
  ai: '#a78bfa',          // --ai
  unread: '#fbbf24',
  wash: 'rgba(255, 255, 255, 0.06)',
  swipeArchive: '#1f6f43',
  swipeDelete: '#8f2b27',
};

export const lightPalette: Palette = {
  bg: '#e7e8ee',          // --bg
  bgElevated: '#ffffff',  // --surface
  bgAlt: '#f8f9fb',       // --surface-2
  bgInput: '#eaebf0',     // --surface-3
  border: '#ced0d9',      // --line
  text: '#17171b',        // --ink
  textMuted: '#5e5f69',   // --ink-2
  textFaint: '#8e909c',   // --ink-3
  accent: '#f59e0b',      // --accent
  accentText: '#201500',
  accentSoft: 'rgba(245, 158, 11, 0.16)',
  danger: '#d72d28',      // --danger
  dangerSoft: 'rgba(215, 45, 40, 0.12)',
  success: '#169655',     // --success
  info: '#0071e3',        // --info
  ai: '#7c3aed',          // --ai
  unread: '#b45309',      // --accent-ink: amber has no contrast on white
  wash: 'rgba(0, 0, 0, 0.05)',
  swipeArchive: '#169655',
  swipeDelete: '#d72d28',
};

/** Corner radii. Larger than stock RN defaults, matching the desktop panes. */
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
};

/** A 4pt spacing ramp, so padding is never invented per screen. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

/** The type scale. Sizes and weights are fixed; only the colour varies. */
export function makeType(palette: Palette) {
  return {
    title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.4, color: palette.text },
    heading: { fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.2, color: palette.text },
    body: { fontSize: 15, fontWeight: '400' as const, color: palette.text },
    bodyStrong: { fontSize: 15, fontWeight: '600' as const, color: palette.text },
    secondary: { fontSize: 13.5, fontWeight: '400' as const, color: palette.textMuted },
    caption: { fontSize: 12, fontWeight: '400' as const, color: palette.textFaint },
    overline: {
      fontSize: 11,
      fontWeight: '600' as const,
      letterSpacing: 0.8,
      color: palette.textFaint,
      textTransform: 'uppercase' as const,
    },
  };
}

export type TypeScale = ReturnType<typeof makeType>;

// Avatar colours are chosen to sit under white text in both themes, so they do
// not change with the palette.
export const avatarColors = [
  '#1d4ed8', '#7c3aed', '#059669', '#d97706',
  '#db2777', '#0891b2', '#dc2626', '#4338ca',
];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (const c of seed) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  return avatarColors[hash % avatarColors.length];
}
