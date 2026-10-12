import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useEmailStore } from '../store/emailStore'
import { emailsApi } from '../api/client'
import * as localOutbox from '../lib/localOutbox'
import type { OutboxItem, OutboxStatus } from '../types/email'
import { confirmDialog } from './DialogHost'
import { useT } from '../lib/i18n'

const STATUS_STYLES: Record<OutboxStatus, { label: string; className: string }> = {
  uncertain: { label: 'Delivery uncertain', className: 'bg-danger/10 text-danger' },
  pending: { label: 'Queued', className: 'bg-info/10 text-info' },
  sending: { label: 'Sending', className: 'bg-accent/10 text-accent-ink ' },
  retrying: { label: 'Retrying', className: 'bg-accent/10 text-accent-ink ' },
  sent: { label: 'Sent', className: 'bg-success/15 text-success ' },
  failed: { label: 'Failed', className: 'bg-danger/10 text-danger ' },
  cancelled: { label: 'Cancelled', className: 'bg-surface-3 text-ink-2 ' },
}

function relative(iso?: string | null) {
  if (!iso) return ''
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' }
}

export function OutboxModal() {
  const { setShowOutboxModal, showNotification, outbox, setOutbox, accounts } = useEmailStore()
  const editingId = useRef<string | null>(null);
  const [editing, setEditing] = useState<OutboxItem | null>(null)
  const [editTo, setEditTo] = useState('')
  const [editSubject, setEditSubject] = useState('')
  const [bodyEdited, setBodyEdited] = useState(false)
  const [editText, setEditText] = useState<string | undefined>(undefined)
  const [editAt, setEditAt] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const t = useT()
  // Messages that never reached the backend. They are not in `outbox` because
  // the server has never seen them, and showing them as "Queued" alongside
  // messages it has accepted would misdescribe both.
  const [parked, setParked] = useState<localOutbox.LocalOutboxItem[]>([])

  useEffect(() => localOutbox.subscribe(setParked), [])

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
      if (action === 'retry') {
        if (item.status === 'uncertain' && !await confirmDialog({ title: t('Check Sent mail first'), body: t('Delivery may already have succeeded. Retrying can send a duplicate. Have you checked Sent mail?'), confirmLabel: t('Retry anyway') })) return
        await emailsApi.retryOutbox(item.id, item.status === 'uncertain')
      }
      else if (action === 'cancel') await emailsApi.cancelOutbox(item.id)
      else await emailsApi.discardOutbox(item.id)
      await refresh()
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : t({ retry: 'Could not retry this message', cancel: 'Could not cancel this message', discard: 'Could not discard this message' }[action]))
    } finally {
      setBusyId(null)
    }
  }

  const accountEmail = (id: string) => accounts.find(a => a.id === id)?.email || ''

  const retryParked = async () => {
    setBusyId('local')
    try {
      const sent = await localOutbox.flush(true)
      if (sent) showNotification('success', t(sent === 1 ? 'Sent {count} message' : 'Sent {count} messages', { count: sent }))
      else showNotification('error', t('Still cannot reach the Hermes service'))
      await refresh()
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const renderParkedRow = (item: localOutbox.LocalOutboxItem) => (
    <div key={item.id} className="rounded-xl border border-line/50 bg-ink/4 p-3.5">
      <div className="flex items-start gap-2">
        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide flex-shrink-0 mt-0.5 bg-danger/10 text-danger">
          {t(item.rejected ? 'Rejected' : 'Offline')}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-ink truncate">{item.subject}</div>
          <div className="text-[11px] text-ink-2 truncate">
            {t('To')} {item.to || '—'}
            {accountEmail(item.accountId) && <span className="text-ink-3"> · {t('from {email}', { email: accountEmail(item.accountId) })}</span>}
          </div>
          <div className="text-[10px] text-ink-3 mt-0.5">
            {t('Held on this device since {when} — sends automatically once Hermes reconnects', { when: relative(item.queuedAt) })}
          </div>
          {item.lastError && (
            <div className="text-[10px] text-danger mt-1 break-words">{item.lastError}</div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={retryParked}
            disabled={busyId === 'local'}
            className="text-[11px] px-2 py-1 rounded text-info hover:bg-info/10 disabled:opacity-50"
          >
            {t('Try now')}
          </button>
          <button
            onClick={() => localOutbox.remove(item.id).catch(err => showNotification('error', String(err)))}
            className="text-[11px] px-2 py-1 rounded text-danger hover:bg-danger/10"
            title={t('Discard this message without sending')}
          >
            {t('Discard')}
          </button>
        </div>
      </div>
    </div>
  )
  const active = outbox.filter(i => i.status !== 'sent' && i.status !== 'cancelled')
  const finished = outbox.filter(i => i.status === 'sent' || i.status === 'cancelled')

  const renderRow = (item: OutboxItem) => {
    const style = STATUS_STYLES[item.status] ?? STATUS_STYLES.pending
    const canRetry = item.status === 'failed' || item.status === 'uncertain'
    const canCancel = item.status === 'pending' || item.status === 'retrying' || item.status === 'failed'

    return (
      <div key={item.id} className="rounded-xl border border-line/50 bg-ink/4 p-3.5">
        <div className="flex items-start gap-2">
          <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide flex-shrink-0 mt-0.5 ${style.className}`}>
            {t(style.label)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-ink truncate">
              {item.subject || t('(no subject)')}
            </div>
            <div className="text-[11px] text-ink-2 truncate">
              {t('To')} {item.to || '—'}
              {accountEmail(item.accountId) && <span className="text-ink-3"> · {t('from {email}', { email: accountEmail(item.accountId) })}</span>}
              {item.hasAttachments && <span className="text-ink-3"> · {t('has attachments')}</span>}
            </div>
            {item.status === 'pending' && item.sendAt && new Date(item.sendAt).getTime() > Date.now() && (
              <div className="text-[10px] text-ink-3 mt-0.5">
                {t('Sends {when}', { when: relative(item.sendAt) })}
              </div>
            )}
            {item.status === 'retrying' && (
              <div className="text-[10px] text-accent-ink mt-0.5">
                {t('Attempt {count} failed — next try {when}', { count: item.attempts ?? 0, when: relative(item.nextAttemptAt) })}
              </div>
            )}
            {item.status === 'sent' && (
              <div className="text-[10px] text-ink-3 mt-0.5">{t('Sent {when}', { when: relative(item.sentAt) })}</div>
            )}
            {!!item.history?.length && <details className="text-xs mt-2"><summary>{t('Delivery history')}</summary>{item.history.map((event, index) => <p key={index}>{new Date(event.at).toLocaleString()} - {t(event.status)} {event.detail}</p>)}<p>{t('Sent means accepted by the mail provider; recipient delivery is not guaranteed.')}</p></details>}
            {item.error && (item.status === 'failed' || item.status === 'uncertain') && (
              <div className="text-[10px] text-danger mt-1 break-words">{item.error}</div>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {['pending', 'retrying', 'failed', 'cancelled'].includes(item.status) && <button className="text-xs text-info" onClick={() => { editingId.current = item.id; setEditing(item); setEditTo(item.to); setEditSubject(item.subject); setEditAt(''); setEditText(undefined); setBodyEdited(false); emailsApi.outboxDetail(item.id).then(detail => { if (editingId.current === item.id) setEditText(detail.email?.text || '') }).catch(e => showNotification('error', String(e))) }}>{t('Edit / reschedule')}</button>}
            {canRetry && (
              <button
                onClick={() => act(item, 'retry')}
                disabled={busyId === item.id}
                className="text-[11px] px-2 py-1 rounded text-info hover:bg-info/10 disabled:opacity-50"
              >
                {t('Retry now')}
              </button>
            )}
            {canCancel && (
              <button
                onClick={() => act(item, 'cancel')}
                disabled={busyId === item.id}
                className="text-[12px] px-2.5 py-1 rounded-lg text-ink-2 hover:bg-ink/8 hover:text-ink transition-colors disabled:opacity-50"
              >
                {t('Cancel')}
              </button>
            )}
            <button
              onClick={() => act(item, 'discard')}
              disabled={busyId === item.id}
              className="text-[11px] px-2 py-1 rounded text-danger hover:bg-danger/10 disabled:opacity-50"
              title={t('Remove from the outbox without sending')}
            >
              {t('Discard')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-md z-[90] flex items-center justify-center p-4 animate-fade" onClick={() => setShowOutboxModal(false)}>
      <div
        onClick={e => e.stopPropagation()}
        className="glass-elevated rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden animate-rise"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line flex-shrink-0">
          <div>
            <h2 className="font-semibold text-sm text-ink ">{t('Outbox')}</h2>
            <p className="text-[11px] text-ink-3 mt-0.5">
              {t('Messages waiting to send. Network failures retry automatically with backoff.')}
            </p>
          </div>
          <button onClick={() => setShowOutboxModal(false)} aria-label={t('Close')} className="text-ink-3 hover:text-ink p-1 rounded transition-colors">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
          {!outbox.length && !parked.length && (
            <p className="text-xs text-ink-3 py-8 text-center">
              {t('Nothing waiting to send.')}
            </p>
          )}
          {parked.length > 0 && (
            <>
              <div className="text-[10px] font-bold uppercase tracking-widest text-ink-3">
                {t('Waiting on this device')}
              </div>
              {parked.map(renderParkedRow)}
              {active.length > 0 && (
                <div className="text-[10px] font-bold uppercase tracking-widest text-ink-3 pt-3">
                  {t('On the server')}
                </div>
              )}
            </>
          )}
          {editing && <form className="space-y-2 border border-line rounded-xl p-3" onSubmit={async e => {
            e.preventDefault(); setBusyId(editing.id)
            try { await emailsApi.editOutbox(editing.id, { to: editTo, subject: editSubject, text: bodyEdited ? editText : undefined, sendAt: editAt ? new Date(editAt).toISOString() : undefined }); setEditing(null); await refresh() }
            catch (error) { showNotification('error', String(error)) } finally { setBusyId(null) }
          }}>
            <label className="block">{t('To')}<input required aria-label="Edit recipient" className="field w-full" value={editTo} onChange={e => setEditTo(e.target.value)} /></label>
            <label className="block">{t('Subject')}<input aria-label="Edit subject" className="field w-full" value={editSubject} onChange={e => setEditSubject(e.target.value)} /></label>
            <label className="block">{t('Message (plain text)')}<textarea aria-label="Edit message" className="field w-full" value={editText ?? ''} disabled={editText === undefined} onChange={e => { setBodyEdited(true); setEditText(e.target.value) }} /></label>
            <label className="block">{t('Send at (leave empty to send now)')}<input aria-label="Reschedule" type="datetime-local" className="field" value={editAt} onChange={e => setEditAt(e.target.value)} /></label>
            <button disabled={!!busyId} className="text-info">{t('Save and queue')}</button> <button type="button" onClick={() => setEditing(null)}>{t('Cancel')}</button>
          </form>}
          {active.map(renderRow)}
          {finished.length > 0 && (
            <>
              <div className="text-[10px] font-bold uppercase tracking-widest text-ink-3 pt-3">
                {t('Recently completed')}
              </div>
              {finished.map(renderRow)}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
