/**
 * Shared email-rendering policy.
 *
 * The desktop reader blocked tracking pixels and remote images; the mobile
 * reader did not, because each client had implemented its own sanitizer. The
 * privacy posture differed between the two in a way no user could discover.
 *
 * Everything here is pure and dependency-free so both a DOM environment
 * (desktop, via DOMPurify) and a non-DOM one (React Native, via regex
 * transforms) can enforce the same rules. Anything needing a DOM lives in the
 * per-platform adapter, never here.
 */

/** Tags an email body may contain. Everything else is stripped. */
export const ALLOWED_TAGS = [
  'p', 'div', 'span', 'a', 'b', 'i', 'em', 'strong', 'br', 'u', 's', 'sub', 'sup',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'img', 'blockquote', 'pre', 'code', 'hr', 'font', 'center', 'small', 'big',
] as const

/** Attributes that survive on an allowed tag. */
export const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel',
  'colspan', 'rowspan', 'width', 'height', 'align', 'valign',
  'color', 'size', 'face', 'bgcolor', 'cellpadding', 'cellspacing', 'border',
] as const

/**
 * URL schemes a link may use. `javascript:` and `data:` are the ones that
 * matter — both turn a click into code execution or a spoofed download.
 */
const SAFE_LINK_SCHEMES = /^(https?|mailto|tel|callto|sms|webcal):/i

export function isSafeLinkHref(href: string): boolean {
  const value = String(href || '').trim()
  if (!value) return false
  // A relative or anchor href has no scheme and cannot execute.
  if (/^[#/?]/.test(value)) return true
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return true
  return SAFE_LINK_SCHEMES.test(value)
}

/** Does this src point somewhere off-device? */
export function isRemoteSrc(src: string): boolean {
  const value = String(src || '').trim()
  return /^https?:\/\//i.test(value) || value.startsWith('//')
}

/**
 * A tracking pixel declares itself: a 1×1 (or smaller) image exists to report
 * that the message was opened, not to be looked at.
 *
 * Missing dimensions must NOT read as zero. Most legitimate images omit width
 * and height entirely, and treating that as 1×1 removes them permanently —
 * "Show images" then has nothing left to restore.
 */
export function isTrackingPixel(width: string | null, height: string | null): boolean {
  if (width === null || height === null) return false
  // An empty attribute is an absent one. Number('') is 0, so without this a
  // <img width="" height=""> would be read as 0×0 and deleted as a pixel.
  if (String(width).trim() === '' || String(height).trim() === '') return false
  const w = Number(width)
  const h = Number(height)
  if (Number.isNaN(w) || Number.isNaN(h)) return false
  return w <= 1 && h <= 1
}

/** Inline styles that reach out to the network, e.g. background:url(https://…). */
export function hasRemoteStyleUrl(style: string): boolean {
  return /url\s*\(\s*['"]?(?:https?:)?\/\//i.test(String(style || ''))
}

/**
 * Styles that let a message escape its own box and draw over the application's
 * chrome — the basis of a convincing in-app phishing prompt. Only relevant to
 * the desktop reader, which renders into a shared document; kept here so both
 * clients agree on what counts as dangerous.
 */
const ESCAPING_STYLE = /(?:^|[;\s])(position\s*:\s*(?:fixed|sticky|absolute)|z-index\s*:|transform\s*:|opacity\s*:\s*0(?:\.0*)?\s*(?:;|$))/i

export function hasEscapingStyle(style: string): boolean {
  return ESCAPING_STYLE.test(String(style || ''))
}

export interface BlockCounts {
  /** Remote images hidden until the reader opts in. */
  images: number
  /** Tracking pixels removed outright — these never come back. */
  pixels: number
  /** Style declarations neutralised. */
  styles: number
}

export const emptyBlockCounts = (): BlockCounts => ({ images: 0, pixels: 0, styles: 0 })

export const totalBlocked = (counts: BlockCounts): number =>
  counts.images + counts.pixels + counts.styles

/** The alt text shown in place of an image the reader has not yet allowed. */
export const BLOCKED_IMAGE_ALT = '[image blocked]'

const UNSUBSCRIBE_PATTERN = /unsubscribe|opt[-_ ]?out|manage\s+(?:your\s+)?preferences|email\s+preferences/i

export function looksLikeUnsubscribe(text: string): boolean {
  return UNSUBSCRIBE_PATTERN.test(String(text || ''))
}

/**
 * Find the unsubscribe link in a message.
 *
 * `listUnsubscribe` is the List-Unsubscribe header, which is authoritative when
 * present; the body scan is the fallback for senders that omit it.
 */
export function extractUnsubscribeUrl(opts: {
  listUnsubscribe?: string
  links?: Array<{ href: string; text: string }>
  plainText?: string
}): string | null {
  const header = String(opts.listUnsubscribe || '')
  if (header) {
    // Header form: <https://…>, <mailto:…> — prefer the HTTP one.
    const urls = Array.from(header.matchAll(/<([^>]+)>/g)).map(m => m[1].trim())
    const http = urls.find(u => /^https?:/i.test(u))
    if (http) return http
    if (urls.length) return urls[0]
  }

  for (const link of opts.links || []) {
    if (!isSafeLinkHref(link.href)) continue
    if (looksLikeUnsubscribe(`${link.text} ${link.href}`)) return link.href
  }

  const matches = String(opts.plainText || '').match(/https?:\/\/\S+/gi) || []
  const found = matches.find(url => looksLikeUnsubscribe(url))
  // Trailing punctuation is almost always sentence punctuation, not the URL.
  return found ? found.replace(/[)>.,;:]+$/, '') : null
}

/**
 * Strip markup to readable text. Used for previews, quoting on reply, and the
 * plain-text half of a message the user composes.
 */
export function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Escape text for safe interpolation into HTML we generate ourselves. */
export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
