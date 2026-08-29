import { useState } from 'react'
import type { SenderAuthentication } from '../types/email'

/**
 * Shows whether the provider could confirm the message really came from the
 * domain it claims. This is the strongest anti-phishing signal a mail client
 * has, and it costs one header read — the receiving provider already did the
 * DKIM, SPF, and DMARC work.
 *
 * A pass is deliberately understated and a failure is loud: the point is to
 * make the unusual case visible, not to decorate every message with a tick.
 */

const STYLES: Record<SenderAuthentication['status'], { className: string; icon: string }> = {
  pass:    { className: 'text-ok',    icon: 'M2 6.5l2.6 2.6L10 3.5' },
  partial: { className: 'text-warn',  icon: 'M6 2.5v4.2M6 9.3v.2' },
  fail:    { className: 'text-error', icon: 'M6 2.5v4.2M6 9.3v.2' },
  unknown: { className: 'text-ink-3', icon: 'M6 2.5v4.2M6 9.3v.2' },
}

export function SenderBadge({ authentication }: { authentication?: SenderAuthentication | null }) {
  const [open, setOpen] = useState(false)

  // An unverifiable message is the common case for personal mail servers, so
  // saying "not verified" on every one of them would be noise. Only speak up
  // when there is something to say.
  if (!authentication || authentication.status === 'unknown') return null

  const style = STYLES[authentication.status]
  const mechanisms = [
    ['SPF', authentication.spf],
    ['DKIM', authentication.dkim],
    ['DMARC', authentication.dmarc],
  ].filter(([, value]) => value) as Array<[string, string]>

  return (
    <div className="relative inline-flex">
      <button
        onClick={() => setOpen(v => !v)}
        onBlur={() => setOpen(false)}
        className={`inline-flex items-center gap-1.5 rounded-full border border-current/25 px-2 py-0.5 text-[11px] font-medium transition-opacity hover:opacity-75 ${style.className}`}
        aria-expanded={open}
        title={authentication.detail}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d={style.icon} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {authentication.label}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-72 rounded-xl border border-line bg-surface p-3 shadow-lg">
          <p className="text-[12.5px] leading-relaxed text-ink-2">{authentication.detail}</p>
          {mechanisms.length > 0 && (
            <dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-line/60 pt-2.5">
              {mechanisms.map(([name, value]) => (
                <div key={name} className="flex items-baseline gap-1.5">
                  <dt className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">{name}</dt>
                  <dd className={`text-[12px] ${value === 'pass' ? 'text-ok' : value === 'fail' ? 'text-error' : 'text-ink-2'}`}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {authentication.alignedDomain && (
            <p className="mt-2 text-[11.5px] text-ink-3">
              Signed by <span className="text-ink-2">{authentication.alignedDomain}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
