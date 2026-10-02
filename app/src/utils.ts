export function senderName(from: string): string {
  const m = from.match(/^([^<]+)</);
  if (m) return m[1].trim().replace(/^"|"$/g, '');
  const e = from.match(/^<?([^>]+)>?$/);
  return e ? e[1].trim() : from;
}

export function initials(from: string): string {
  const name = senderName(from).replace(/<.*>/, '').trim();
  if (!name) return '?';
  const parts = name.split(/\s+/);
  if (parts.length >= 2 && parts[0][0] && parts[1][0]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatFullDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "3 days ago" / "in 2 hours", coarse enough for reminders and send times. */
export function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return '';
  const ms = new Date(dateStr).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  const abs = Math.abs(ms);
  const units: [number, string][] = [[86400000, 'day'], [3600000, 'hour'], [60000, 'minute']];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const n = Math.round(abs / size);
      const label = `${n} ${unit}${n === 1 ? '' : 's'}`;
      return ms < 0 ? `${label} ago` : `in ${label}`;
    }
  }
  return ms < 0 ? 'just now' : 'in a moment';
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
