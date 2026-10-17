import { parseDocument } from 'htmlparser2';
import serialize from 'dom-serializer';
import { ALLOWED_TAGS, ALLOWED_ATTR } from '../../shared/emailPolicy';
import {
  isSafeLinkHref, isTrackingPixel,
  emptyBlockCounts, extractUnsubscribeUrl, BLOCKED_IMAGE_ALT,
  type BlockCounts,
} from '../../shared/emailPolicy';

export type { BlockCounts };
export { totalBlocked, htmlToText } from '../../shared/emailPolicy';

/** Sanitize the same parsed tree the mobile HTML renderer consumes. */
export interface SanitizeResult {
  html: string;
  blocked: BlockCounts;
}

export function sanitizeEmailHtml(html: string, allowRemoteImages: boolean): SanitizeResult {
  const blocked = emptyBlockCounts();
  const doc = parseDocument(String(html || ''), { decodeEntities: true });
  const allowedTags = new Set<string>(ALLOWED_TAGS);
  const allowedAttrs = new Set<string>(ALLOWED_ATTR);
  const clean = (parent: any) => {
    parent.children = (parent.children || []).filter((node: any) => {
      if (node.type === 'text') return true;
      if (!node.name || !allowedTags.has(node.name) || /^(script|style|iframe|svg|math|form)$/.test(node.name)) return false;
      for (const name of Object.keys(node.attribs || {})) {
        if (!allowedAttrs.has(name) || /^on/i.test(name) || name === 'srcset') delete node.attribs[name];
      }
      if (node.name === 'img') {
        const attrs = node.attribs;
        if (isTrackingPixel(attrs.width ?? null, attrs.height ?? null)) { blocked.pixels++; return false; }
        // Only data images are local. Unknown schemes and relative URLs fail closed.
        if (!isAllowedImageSource(attrs.src || '', allowRemoteImages)) {
          delete attrs.src; attrs.alt = attrs.alt || BLOCKED_IMAGE_ALT; blocked.images++;
        }
      }
      if (node.attribs.href && !isSafeLinkHref(node.attribs.href)) delete node.attribs.href;
      if (node.attribs.style && /url\s*\(|@import/i.test(node.attribs.style)) {
        delete node.attribs.style; blocked.styles++;
      }
      clean(node); return true;
    });
  };
  clean(doc);
  return { html: serialize(doc), blocked };
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

/** Also used by the renderer as a second enforcement point. */
export function isAllowedImageSource(src: string, allowRemote: boolean): boolean {
  const value = String(src).replace(/[\t\n\r]/g, '').trim();
  return /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value)
    || (allowRemote && /^https:\/\//i.test(value));
}
