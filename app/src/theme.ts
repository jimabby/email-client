// Hermes dark theme.
//
// The colours are the desktop client's dark tokens from
// frontend/src/index.css — keep the two in step, or the phone and the desktop
// stop looking like the same product. The scales below (radius, spacing, type)
// mirror the same design language: generous corners, hairline separators, and
// a tight type ramp.
export const theme = {
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
  // A translucent white, for hover/pressed washes over any surface.
  wash: 'rgba(255, 255, 255, 0.06)',
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

/** The type scale. Sizes and weights are fixed here rather than per screen. */
export const type = {
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.4, color: theme.text },
  heading: { fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.2, color: theme.text },
  body: { fontSize: 15, fontWeight: '400' as const, color: theme.text },
  bodyStrong: { fontSize: 15, fontWeight: '600' as const, color: theme.text },
  secondary: { fontSize: 13.5, fontWeight: '400' as const, color: theme.textMuted },
  caption: { fontSize: 12, fontWeight: '400' as const, color: theme.textFaint },
  overline: {
    fontSize: 11,
    fontWeight: '600' as const,
    letterSpacing: 0.8,
    color: theme.textFaint,
    textTransform: 'uppercase' as const,
  },
};

export const avatarColors = [
  '#1d4ed8', '#7c3aed', '#059669', '#d97706',
  '#db2777', '#0891b2', '#dc2626', '#4338ca',
];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (const c of seed) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  return avatarColors[hash % avatarColors.length];
}
