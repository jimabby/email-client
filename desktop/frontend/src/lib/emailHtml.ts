import DOMPurify from 'dompurify'
import {
  ALLOWED_TAGS, ALLOWED_ATTR, emptyBlockCounts, extractUnsubscribeUrl,
  hasRemoteStyleUrl, isRemoteSrc, isSafeLinkHref, isTrackingPixel,
  BLOCKED_IMAGE_ALT, type BlockCounts,
} from '../../../../shared/emailPolicy'

export type { BlockCounts }
export { totalBlocked, htmlToText, escapeHtml } from '../../../../shared/emailPolicy'

export interface SanitizeResult {
  html: string
  blocked: BlockCounts
}

/**
 * DOM-side enforcement of the shared policy.
 *
 * The result is rendered inside a sandboxed iframe (see ReaderFrame), so this
 * is defence in depth rather than the only barrier — but it is what strips
 * tracking pixels and holds back remote images, which the sandbox cannot do.
 */
/** Remote url(...) references anywhere in a stylesheet. */
const REMOTE_CSS_URL = /url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi

/**
 * Neutralise a <style> block: @import always goes (it fetches, and can pull
 * in anything), and remote url()s go until the reader allows remote content.
 */
function cleanStylesheet(css: string, allowRemote: boolean): { css: string; blocked: number } {
  let blocked = 0
  let out = css.replace(/@import[^;]*;?/gi, () => { blocked++; return '' })
  if (!allowRemote) {
    out = out.replace(REMOTE_CSS_URL, () => { blocked++; return 'none' })
  }
  return { css: out, blocked }
}

export function sanitizeEmailHtml(html: string, allowRemoteImages: boolean): SanitizeResult {
  const blocked = emptyBlockCounts()

  const clean = DOMPurify.sanitize(String(html || ''), {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    // <style> blocks carry the layout of nearly every newsletter; stripping
    // them left most marketing mail as a column of unstyled text. They are
    // safe to keep now that the body renders in a sandboxed frame of its own —
    // a stylesheet there can only restyle the message — and their remote
    // references are handled below. FORCE_BODY keeps a leading <style> from
    // being dropped as part of a <head>.
    ADD_TAGS: ['style'],
    FORCE_BODY: true,
    // Keep the document fragment; we walk it below.
    RETURN_DOM_FRAGMENT: false,
    RETURN_DOM: false,
  })

  const doc = new DOMParser().parseFromString(clean, 'text/html')

  for (const style of Array.from(doc.querySelectorAll('style'))) {
    const result = cleanStylesheet(style.textContent || '', allowRemoteImages)
    style.textContent = result.css
    blocked.styles += result.blocked
  }

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || ''

    if (isTrackingPixel(img.getAttribute('width'), img.getAttribute('height'))) {
      img.remove()
      blocked.pixels++
      continue
    }

    if (isRemoteSrc(src) && !allowRemoteImages) {
      // Park the real URL so "Show images" can restore it without re-parsing.
      img.setAttribute('data-blocked-src', src)
      img.removeAttribute('src')
      img.setAttribute('alt', img.getAttribute('alt') || BLOCKED_IMAGE_ALT)
      blocked.images++
    }
  }

  // Escaping styles (position:fixed, z-index…) used to be stripped as well,
  // because the body once shared the app's document and could draw over its
  // chrome. In its own sandboxed frame it cannot, and removing them broke
  // ordinary layouts — and un-hid the preheader text newsletters keep at
  // opacity:0. Only styles that reach the network are touched now.
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[style]'))) {
    const style = el.getAttribute('style') || ''
    if (!allowRemoteImages && hasRemoteStyleUrl(style)) {
      el.removeAttribute('style')
      blocked.styles++
    }
  }

  for (const a of Array.from(doc.querySelectorAll('a'))) {
    const href = a.getAttribute('href') || ''
    if (!isSafeLinkHref(href)) {
      a.removeAttribute('href')
      continue
    }
    a.setAttribute('rel', 'noopener noreferrer')
    a.setAttribute('target', '_blank')
  }

  return { html: doc.body.innerHTML, blocked }
}

/** Pull the unsubscribe link out of a message, header first. */
export function findUnsubscribeUrl(
  html?: string,
  text?: string,
  listUnsubscribe?: string,
): string | null {
  let links: Array<{ href: string; text: string }> = []
  if (html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      links = Array.from(doc.querySelectorAll('a[href]')).map(a => ({
        href: a.getAttribute('href') || '',
        text: a.textContent || '',
      }))
    } catch { /* fall through to the plain-text scan */ }
  }
  return extractUnsubscribeUrl({ listUnsubscribe, links, plainText: text || html })
}

/**
 * Wrap sanitized body HTML in a complete document for the reader iframe.
 *
 * The iframe is sandboxed with neither `allow-scripts` nor `allow-same-origin`,
 * so this document has no script access and an opaque origin — it cannot reach
 * the parent, the API token, or anything else. `allow-popups` plus a base
 * target is what keeps links working: they open in the real browser.
 */
export function buildReaderDocument(bodyHtml: string, theme: 'light' | 'dark', allowRemote = false): string {
  const palette = theme === 'dark'
    ? { bg: '#12161d', fg: '#e6e9ef', muted: '#8b95a5', link: '#7ab7ff', quote: '#2b323d' }
    : { bg: '#ffffff', fg: '#1a1d23', muted: '#6b7280', link: '#1a56c4', quote: '#e3e7ec' }

  // A policy of the message's own, as the backstop behind the sanitizer: until
  // the reader chooses "Show images", nothing in this document may reach the
  // network at all, whatever a stylesheet or attribute the sanitizer missed
  // asks for. (A srcdoc frame also inherits the app's policy; this narrows it.)
  const remote = allowRemote ? ' https:' : ''
  const csp = `default-src 'none'; img-src data: cid: blob:${remote}; style-src 'unsafe-inline'; font-src data:${remote}; media-src data: blob:${remote}`

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; background: ${palette.bg}; color: ${palette.fg}; }
  body {
    font: 14.5px/1.62 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 4px 2px 24px;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; }
  a { color: ${palette.link}; }
  /* Wide tables scroll inside the message instead of stretching the reader. */
  table { max-width: 100%; border-collapse: collapse; }
  pre { white-space: pre-wrap; overflow-x: auto; }
  blockquote {
    margin: 12px 0; padding: 2px 0 2px 14px;
    border-left: 2px solid ${palette.quote}; color: ${palette.muted};
  }
  img[data-blocked-src] {
    min-width: 20px; min-height: 20px;
    border: 1px dashed ${palette.quote}; border-radius: 4px;
    padding: 8px; color: ${palette.muted}; font-size: 12px;
  }
</style>
</head>
<body>${bodyHtml}</body>
</html>`
}
