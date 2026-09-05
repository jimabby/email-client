import { useEffect, useMemo, useRef, useState } from 'react'
import { buildReaderDocument } from '../lib/emailHtml'

interface Props {
  /** Already sanitized body HTML. */
  html: string
  theme: 'light' | 'dark'
}

/**
 * Renders a message inside a sandboxed iframe.
 *
 * Previously the body went straight into the application document via
 * dangerouslySetInnerHTML. DOMPurify kept scripts out, but inline CSS could
 * still position content over the app's own chrome — which is all a convincing
 * in-app phishing prompt needs.
 *
 * The sandbox withholds `allow-scripts`, and that alone is the guarantee: no
 * script in this document runs, whatever survived the sanitizer. The two
 * capabilities it does grant are `allow-popups` (so `target="_blank"` links
 * open in the real browser) and `allow-same-origin` (so the parent can measure
 * the content and not clip long messages). See the note on the iframe below for
 * why that second one is safe here.
 */
export function ReaderFrame({ html, theme }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(320)

  const srcDoc = useMemo(() => buildReaderDocument(html, theme), [html, theme])

  // Measured from the parent, which is why the sandbox grants
  // `allow-same-origin` — see the note on the iframe below.
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    let cancelled = false

    const measure = () => {
      if (cancelled) return
      try {
        const doc = frame.contentDocument
        if (!doc?.body) return
        const next = Math.max(
          doc.body.scrollHeight,
          doc.documentElement?.scrollHeight || 0,
        )
        if (next > 0) setHeight(Math.min(next + 16, 20000))
      } catch {
        // Leave the last known height in place rather than collapsing.
      }
    }

    frame.addEventListener('load', measure)
    // Images and webfonts settle after load, so re-measure a few times rather
    // than leaving the message clipped.
    const timers = [80, 300, 900, 2000].map(delay => window.setTimeout(measure, delay))

    return () => {
      cancelled = true
      frame.removeEventListener('load', measure)
      timers.forEach(window.clearTimeout)
    }
  }, [srcDoc])

  return (
    <iframe
      ref={frameRef}
      title="Message"
      // `allow-scripts` is deliberately absent, and that is the whole guarantee:
      // the browser then refuses to run any script in this document — inline,
      // external, event handlers, javascript: URLs — regardless of what
      // survived the sanitizer. `allow-same-origin` is safe precisely because
      // of that (the dangerous combination is the two together, which would let
      // the frame remove its own sandbox), and it is what lets the parent
      // measure the content so a long message is not clipped.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      className="w-full border-0 bg-transparent"
      style={{ height }}
    />
  )
}
