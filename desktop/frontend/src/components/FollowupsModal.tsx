import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useEmailStore } from '../store/emailStore'
import { emailsApi } from '../api/client'
import type { Followup, FollowupStatus } from '../types/email'

const STATUS_STYLES: Record<FollowupStatus, { label: string; className: string }> = {
  due: { label: 'No reply', className: 'bg-danger/10 text-danger' },
  waiting: { label: 'Waiting', className: 'bg-info/10 text-info' },
  replied: { label: 'Replied', className: 'bg-success/15 text-success' },
}

function relative(iso?: string | null) {
  if (!iso) return ''
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' }
}

/**
 * Sent messages being watched for a reply.
 *
 * The server checks every few minutes against the search index and raises a
 * notification when one comes due unanswered; this is where the user deals
 * with it — nudge the recipient, wait longer, or let it go.
 */
export function FollowupsModal() {
  const { setShowFollowupsModal, showNotification, followups, setFollowups, accounts, openCompose } = useEmailStore()
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try { setFollowups(await emailsApi.getFollowups()) } catch { /* informational */ }
  }, [setFollowups])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  const accountEmail = (id: string) => accounts.find(a => a.id === id)?.email || ''

  const run = async (item: Followup, action: () => Promise<unknown>, failure: string) => {
    setBusyId(item.id)
    try {
      await action()
      await refresh()
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : failure)
    } finally {
      setBusyId(null)
    }
  }

  const nudge = (item: Followup) => {
    const subject = /^re:/i.test(item.subject) ? item.subject : `Re: ${item.subject}`
    setShowFollowupsModal(false)
    openCompose({ accountId: item.accountId, to: item.to, subject, body: '' })
  }

  const due = followups.filter(f => f.status === 'due')
  const waiting = followups.filter(f => f.status === 'waiting')
  const replied = followups.filter(f => f.status === 'replied')

  const renderRow = (item: Followup) => {
    const style = STATUS_STYLES[item.status] ?? STATUS_STYLES.waiting
    const busy = busyId === item.id
    return (
      <div key={item.id} className="rounded-xl border border-line/50 bg-ink/4 p-3.5">
        <div className="flex items-start gap-2">
          <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide flex-shrink-0 mt-0.5 ${style.className}`}>
            {style.label}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-ink truncate">{item.subject || '(no subject)'}</div>
            <div className="text-[11px] text-ink-2 truncate">
              To {item.to || '—'}
              {accountEmail(item.accountId) && <span className="text-ink-3"> · from {accountEmail(item.accountId)}</span>}
            </div>
            <div className="text-[10px] text-ink-3 mt-0.5">
              Sent {relative(item.sentAt)}
              {item.status === 'waiting' && <> · reminds {relative(item.dueAt)}</>}
              {item.status === 'due' && <> · no reply since</>}
              {item.status === 'replied' && <> · answered {relative(item.repliedAt)}</>}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {item.status === 'due' && (
              <button onClick={() => nudge(item)} className="text-[11px] px-2 py-1 rounded text-info hover:bg-info/10">
                Follow up
              </button>
            )}
            {item.status !== 'replied' && (
              <select
                value=""
                disabled={busy}
                aria-label="Remind again"
                onChange={e => {
                  const days = Number(e.target.value)
                  if (days) run(item, () => emailsApi.remindFollowupAgain(item.id, days), 'Could not reschedule')
                }}
                className="field text-[11px] px-1.5 py-1 !rounded-lg text-ink-2"
              >
                <option value="">{item.status === 'due' ? 'Remind again…' : 'Change…'}</option>
                <option value={1}>in 1 day</option>
                <option value={3}>in 3 days</option>
                <option value={7}>in 1 week</option>
              </select>
            )}
            <button
              onClick={() => run(item, () => emailsApi.dismissFollowup(item.id), 'Could not dismiss')}
              disabled={busy}
              className="text-[11px] px-2 py-1 rounded text-ink-2 hover:bg-ink/8 disabled:opacity-50"
              title="Stop watching this message"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    )
  }

  const section = (title: string, items: Followup[]) => items.length > 0 && (
    <>
      <div className="text-[10px] font-bold uppercase tracking-widest text-ink-3 pt-2">{title}</div>
      {items.map(renderRow)}
    </>
  )

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-md z-[90] flex items-center justify-center p-4 animate-fade" onClick={() => setShowFollowupsModal(false)}>
      <div
        onClick={e => e.stopPropagation()}
        className="glass-elevated rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden animate-rise"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line flex-shrink-0">
          <div>
            <h2 className="font-semibold text-sm text-ink">Follow-ups</h2>
            <p className="text-[11px] text-ink-3 mt-0.5">
              Sent messages you asked to be reminded about if nobody replies. Set one from the composer.
            </p>
          </div>
          <button onClick={() => setShowFollowupsModal(false)} aria-label="Close" className="text-ink-3 hover:text-ink p-1 rounded transition-colors">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
          {!followups.length && (
            <p className="text-xs text-ink-3 py-8 text-center">
              Nothing to follow up on. Choose “Remind if no reply” when you send a message.
            </p>
          )}
          {section('Needs a nudge', due)}
          {section('Waiting for a reply', waiting)}
          {section('Answered', replied)}
        </div>
      </div>
    </div>
  )
}
