import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useEmailStore } from '../store/emailStore'
import { emailsApi } from '../api/client'
import type { OutboxItem, OutboxStatus } from '../types/email'

const STATUS_STYLES: Record<OutboxStatus, { label: string; className: string }> = {
  pending: { label: 'Queued', className: 'bg-[#ddf4ff] dark:bg-[#0969da]/20 text-[#0969da]' },
  sending: { label: 'Sending', className: 'bg-[#fff8ec] dark:bg-[#f59e0b]/20 text-[#b45309] dark:text-[#f59e0b]' },
  retrying: { label: 'Retrying', className: 'bg-[#fff8ec] dark:bg-[#f59e0b]/20 text-[#b45309] dark:text-[#f59e0b]' },
  sent: { label: 'Sent', className: 'bg-[#dafbe1] dark:bg-[#238636]/25 text-[#116329] dark:text-[#3fb950]' },
  failed: { label: 'Failed', className: 'bg-[#ffeef0] dark:bg-[#f85149]/15 text-[#cf222e] dark:text-[#f85149]' },
  cancelled: { label: 'Cancelled', className: 'bg-[#eaeef2] dark:bg-[#21262d] text-[#656d76] dark:text-[#8b949e]' },
}

function relative(iso?: string | null) {
  if (!iso) return ''
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' }
}

export function OutboxModal() {
  const { setShowOutboxModal, showNotification, outbox, setOutbox, accounts } = useEmailStore()
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setOutbox(await emailsApi.getOutbox())
    } catch {
      // The list is informational; a failed poll shouldn't raise a toast.
    }
  }, [setOutbox])

  useEffect(() => {
    refresh()
    // Statuses change on the server (retries, backoff) with no client action.
    const timer = setInterval(refresh, 4000)
    return () => clearInterval(timer)
  }, [refresh])

  const act = async (item: OutboxItem, action: 'retry' | 'cancel' | 'discard') => {
    setBusyId(item.id)
    try {
      if (action === 'retry') await emailsApi.retryOutbox(item.id)
      else if (action === 'cancel') await emailsApi.cancelOutbox(item.id)
      else await emailsApi.discardOutbox(item.id)
      await refresh()
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : `Could not ${action} this message`)
    } finally {
      setBusyId(null)
    }
  }

  const accountEmail = (id: string) => accounts.find(a => a.id === id)?.email || ''
  const active = outbox.filter(i => i.status !== 'sent' && i.status !== 'cancelled')
  const finished = outbox.filter(i => i.status === 'sent' || i.status === 'cancelled')

  const renderRow = (item: OutboxItem) => {
    const style = STATUS_STYLES[item.status] ?? STATUS_STYLES.pending
    const canRetry = item.status === 'failed'
    const canCancel = item.status === 'pending' || item.status === 'retrying' || item.status === 'failed'

    return (
      <div key={item.id} className="rounded-lg border border-[#d0d7de] dark:border-[#30363d] p-3">
        <div className="flex items-start gap-2">
          <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide flex-shrink-0 mt-0.5 ${style.className}`}>
            {style.label}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-[#1f2328] dark:text-[#e6edf3] truncate">
              {item.subject || '(no subject)'}
            </div>
            <div className="text-[11px] text-[#656d76] dark:text-[#8b949e] truncate">
              To {item.to || '—'}
              {accountEmail(item.accountId) && <span className="text-[#818b98]"> · from {accountEmail(item.accountId)}</span>}
              {item.hasAttachments && <span className="text-[#818b98]"> · has attachments</span>}
            </div>
            {item.status === 'pending' && item.sendAt && new Date(item.sendAt).getTime() > Date.now() && (
              <div className="text-[10px] text-[#818b98] dark:text-[#484f58] mt-0.5">
                Sends {relative(item.sendAt)}
              </div>
            )}
            {item.status === 'retrying' && (
              <div className="text-[10px] text-[#b45309] dark:text-[#f59e0b] mt-0.5">
                Attempt {item.attempts} failed — next try {relative(item.nextAttemptAt)}
              </div>
            )}
            {item.status === 'sent' && (
              <div className="text-[10px] text-[#818b98] dark:text-[#484f58] mt-0.5">Sent {relative(item.sentAt)}</div>
            )}
            {item.error && item.status === 'failed' && (
              <div className="text-[10px] text-[#cf222e] dark:text-[#f85149] mt-1 break-words">{item.error}</div>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {canRetry && (
              <button
                onClick={() => act(item, 'retry')}
                disabled={busyId === item.id}
                className="text-[11px] px-2 py-1 rounded text-[#0969da] hover:bg-[#ddf4ff] dark:hover:bg-[#0969da]/15 disabled:opacity-50"
              >
                Retry now
              </button>
            )}
            {canCancel && (
              <button
                onClick={() => act(item, 'cancel')}
                disabled={busyId === item.id}
                className="text-[11px] px-2 py-1 rounded text-[#656d76] dark:text-[#8b949e] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] disabled:opacity-50"
              >
                Cancel
              </button>
            )}
            <button
              onClick={() => act(item, 'discard')}
              disabled={busyId === item.id}
              className="text-[11px] px-2 py-1 rounded text-[#cf222e] dark:text-[#f85149] hover:bg-[#fff0ee] dark:hover:bg-[#f85149]/10 disabled:opacity-50"
              title="Remove from the outbox without sending"
            >
              Discard
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[90] flex items-center justify-center p-4" onClick={() => setShowOutboxModal(false)}>
      <div
        onClick={e => e.stopPropagation()}
        className="bg-white dark:bg-[#161b22] rounded-xl border border-[#d0d7de] dark:border-[#30363d] shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#d0d7de] dark:border-[#30363d] flex-shrink-0">
          <div>
            <h2 className="font-semibold text-sm text-[#1f2328] dark:text-[#e6edf3]">Outbox</h2>
            <p className="text-[11px] text-[#818b98] dark:text-[#484f58] mt-0.5">
              Messages waiting to send. Network failures retry automatically with backoff.
            </p>
          </div>
          <button onClick={() => setShowOutboxModal(false)} aria-label="Close" className="text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] p-1 rounded transition-colors">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
          {!outbox.length && (
            <p className="text-xs text-[#818b98] dark:text-[#484f58] py-8 text-center">
              Nothing waiting to send.
            </p>
          )}
          {active.map(renderRow)}
          {finished.length > 0 && (
            <>
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#818b98] dark:text-[#484f58] pt-3">
                Recently completed
              </div>
              {finished.map(renderRow)}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
