// Hermes dark theme — matches the desktop client's GitHub-dark palette.
export const theme = {
  bg: '#0d1117',
  bgElevated: '#161b22',
  bgInput: '#21262d',
  border: '#30363d',
  text: '#e6edf3',
  textMuted: '#8b949e',
  textFaint: '#484f58',
  accent: '#f59e0b',
  accentText: '#0d1117',
  danger: '#f85149',
  success: '#3fb950',
  unread: '#f59e0b',
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
