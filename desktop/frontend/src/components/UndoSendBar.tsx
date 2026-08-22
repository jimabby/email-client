import { useEffect, useState } from 'react'
import { useEmailStore } from '../store/emailStore'
import { emailsApi } from '../api/client'

/**
 * The undo-send countdown.
 *
 * Every send is queued server-side, so a message with an undo window really is
 * recallable until `canUndoUntil` passes. Without a visible clock the user has
 * no way to know how long that is — the window silently expires and "Undo"
 * starts failing. This shows the time remaining and removes itself the moment
 * the message is genuinely gone.
 */
export function UndoSendBar() {
  const { pendingSend, clearPendingSend, showNotification, setShowOutboxModal } = useEmailStore()
  const [remainingMs, setRemainingMs] = useState(0)
  const [cancelling, setCancelling] = useState(false)

  const until = pendingSend ? Date.parse(pendingSend.canUndoUntil) : 0

  useEffect(() => {
    if (!pendingSend) return
    setCancelling(false)

    const tick = () => {
      const left = until - Date.now()
      setRemainingMs(left)
      // Once the window closes the message is on its way; the bar has nothing
      // true left to offer, so it goes rather than showing a dead button.
      if (left <= 0) clearPendingSend()
    }
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [pendingSend, until, clearPendingSend])

  if (!pendingSend) return null

  // The window length has to come from the composer — it cannot be recovered
  // from `canUndoUntil` alone once the countdown is already running.
  const totalMs = Math.max(1, pendingSend.windowSec * 1000)
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))

  const undo = async () => {
    if (cancelling) return
    setCancelling(true)
    try {
      await emailsApi.cancelQueuedSend(pendingSend.accountId, pendingSend.jobId)
      clearPendingSend()
      showNotification('success', 'Send cancelled — the message is back in your drafts.')
    } catch (err: unknown) {
      setCancelling(false)
      showNotification('error', err instanceof Error ? err.message : 'Too late to cancel — the message has gone.')
      clearPendingSend()
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[95] flex items-center gap-3 pl-4 pr-2 py-2.5
                 rounded-2xl glass-elevated shadow-pop animate-rise max-w-[min(92vw,30rem)]"
    >
      <CountdownRing seconds={seconds} totalMs={totalMs} remainingMs={remainingMs} />

      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink font-medium truncate">
          Sending “{pendingSend.subject || '(no subject)'}”
        </div>
        <div className="text-[11.5px] text-ink-3 tabular-nums">
          Goes out in {seconds}s
        </div>
      </div>

      <button
        onClick={undo}
        disabled={cancelling}
        className="btn-accent px-3.5 py-1.5 rounded-xl text-[12.5px] font-semibold flex-shrink-0 disabled:opacity-50"
      >
        {cancelling ? 'Undoing…' : 'Undo'}
      </button>

      <button
        onClick={() => { clearPendingSend(); setShowOutboxModal(true) }}
        title="Show in outbox"
        aria-label="Show in outbox"
        className="btn-ghost w-8 h-8 flex items-center justify-center flex-shrink-0"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M1 10h3l1.5 2h5L12 10h3v3a1 1 0 01-1 1H2a1 1 0 01-1-1v-3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
          <path d="M8 8V1M5.5 3.5L8 1l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>
  )
}

/** A draining ring — reads as "time is passing" at a glance, unlike a number. */
function CountdownRing({ seconds, totalMs, remainingMs }: { seconds: number; totalMs: number; remainingMs: number }) {
  const r = 12
  const circumference = 2 * Math.PI * r
  const progress = Math.max(0, Math.min(1, remainingMs / totalMs))

  return (
    <div className="relative w-8 h-8 flex-shrink-0" aria-hidden>
      <svg width="32" height="32" viewBox="0 0 32 32" className="-rotate-90">
        <circle cx="16" cy="16" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" className="text-ink/12" />
        <circle
          cx="16" cy="16" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          className="text-accent"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          style={{ transition: 'stroke-dashoffset 250ms linear' }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10.5px] font-semibold text-ink tabular-nums">
        {seconds}
      </span>
    </div>
  )
}
