import {
  isRemoteSrc, isSafeLinkHref, isTrackingPixel, hasRemoteStyleUrl,
  emptyBlockCounts, extractUnsubscribeUrl, BLOCKED_IMAGE_ALT,
  type BlockCounts,
} from '../../shared/emailPolicy';

export type { BlockCounts };
export { totalBlocked, htmlToText } from '../../shared/emailPolicy';

/**
 * Mobile enforcement of the shared email-rendering policy.
 *
 * React Native has no DOM, so where the desktop reader walks a parsed document
 * with DOMPurify this works on the markup directly. The rules it applies are
 * the same ones, imported from shared/emailPolicy — previously this screen
 * applied none of them and handed raw HTML straight to RenderHtml, which meant
 * every message opened on a phone loaded remote images and confirmed the
 * address to whoever sent it.
 */

// Tags that can execute or fetch, removed with their contents.
const DANGEROUS_BLOCKS = /<(script|style|iframe|object|embed|applet|noscript|svg|math|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// The same tags when self-closed or left unterminated.
const DANGEROUS_TAGS = /<\/?(script|style|iframe|object|embed|applet|noscript|svg|math|form|meta|link|base|input|button|textarea|select)\b[^>]*>/gi;
// on* handlers in any quoting style.
const EVENT_HANDLERS = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

export interface SanitizeResult {
  html: string;
  blocked: BlockCounts;
}

export function sanitizeEmailHtml(html: string, allowRemoteImages: boolean): SanitizeResult {
  const blocked = emptyBlockCounts();
  let out = String(html || '')
    .replace(DANGEROUS_BLOCKS, ' ')
    .replace(DANGEROUS_TAGS, ' ')
    .replace(EVENT_HANDLERS, '');

  // Images: drop tracking pixels outright, hold back everything else remote.
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const attrs = parseAttributes(tag);

    if (isTrackingPixel(attrs.width ?? null, attrs.height ?? null)) {
      blocked.pixels++;
      return '';
    }

    const src = attrs.src || '';
    if (isRemoteSrc(src) && !allowRemoteImages) {
      blocked.images++;
      const alt = attrs.alt || BLOCKED_IMAGE_ALT;
      // RenderHtml needs the tag to stay well-formed; without a src it renders
      // the alt text, which is exactly the placeholder we want.
      return `<img alt="${alt.replace(/"/g, '&quot;')}" />`;
    }
    return tag;
  });

  // Inline styles that fetch from the network.
  if (!allowRemoteImages) {
    out = out.replace(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (whole, dq, sq) => {
      const style = dq ?? sq ?? '';
      if (!hasRemoteStyleUrl(style)) return whole;
      blocked.styles++;
      return '';
    });
  }

  // Links to schemes that are not navigation.
  out = out.replace(/<a\b([^>]*)>/gi, (tag, inner: string) => {
    const attrs = parseAttributes(tag);
    if (attrs.href && !isSafeLinkHref(attrs.href)) {
      return `<a${inner.replace(/\shref\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '')}>`;
    }
    return tag;
  });

  return { html: out, blocked };
}

/** Pull the unsubscribe link out of a message, header first. */
export function findUnsubscribeUrl(
  html?: string,
  text?: string,
  listUnsubscribe?: string,
): string | null {
  const links: Array<{ href: string; text: string }> = [];
  for (const match of String(html || '').matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
    links.push({
      href: match[1] ?? match[2] ?? '',
      text: String(match[3] || '').replace(/<[^>]+>/g, ' '),
    });
  }
  return extractUnsubscribeUrl({ listUnsubscribe, links, plainText: text || html });
}
