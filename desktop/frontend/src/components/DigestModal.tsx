import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useEmailStore } from '../store/emailStore'
import { digestApi } from '../api/client'
import { useT } from '../lib/i18n'
import { Avatar } from './Avatar'
import type { DigestGroup, DigestState, EmailSummary } from '../types/email'

function relative(iso?: string | null) {
  if (!iso) return ''
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' }
}

/**
 * Newsletter digest.
 *
 * With the digest on, newsletters skip the inbox: they are filed into a
 * "Digest" folder silently as they arrive, and one notification at the chosen
 * time says how many are waiting. This is where they are read — grouped by
 * sender — and where a sender who is not really a newsletter is sent back.
 */
export function DigestModal() {
  const { setShowDigestModal, showNotification, setSelectedEmail, setCurrentAccount, setCurrentFolder, setDigestUnread } = useEmailStore()
  const t = useT()
  const [state, setState] = useState<DigestState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [newSender, setNewSender] = useState('')

  const refresh = useCallback(async () => {
    try {
      const next = await digestApi.get()
      setState(next)
      setDigestUnread(next.groups.reduce((sum, g) => sum + g.unread, 0))
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : t('Could not load the digest'))
    } finally {
      setLoading(false)
    }
  }, [showNotification, setDigestUnread, t])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowDigestModal(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setShowDigestModal])

  const configure = async (patch: Partial<DigestState['settings']>, message?: string) => {
    setBusy('settings')
    try {
      await digestApi.configure(patch)
      if (message) showNotification('success', message)
      await refresh()
      window.dispatchEvent(new CustomEvent('hermes:digest-changed'))
    } catch (err) {
      showNotification('error', (err as { response?: { data?: { error?: string } } })?.response?.data?.error || t('Could not change the digest'))
    } finally {
      setBusy(null)
    }
  }

  const release = async (group: DigestGroup) => {
    setBusy(group.sender)
    try {
      const result = await digestApi.release(group.sender)
      showNotification('success', t('{sender} will stay in your inbox — {count} moved back', { sender: group.sender, count: result.moved }))
      await refresh()
      window.dispatchEvent(new CustomEvent('hermes:refresh-list'))
    } catch {
      showNotification('error', t('Could not move that sender back'))
    } finally {
      setBusy(null)
    }
  }

  const readAll = async () => {
    setBusy('read-all')
    try {
      const { marked } = await digestApi.readAll()
      showNotification('success', t('{count} marked as read', { count: marked }))
      await refresh()
    } catch {
      showNotification('error', t('Could not mark the digest as read'))
    } finally {
      setBusy(null)
    }
  }

  const open = (email: EmailSummary & { digestFolder: string }) => {
    setShowDigestModal(false)
    setCurrentAccount(email.accountId)
    setCurrentFolder(email.digestFolder)
    setSelectedEmail({ ...email, folder: email.digestFolder })
  }

  const setSender = async (sender: string, decision: 'digest' | 'keep' | 'remove') => {
    try { await digestApi.setSender(sender, decision); await refresh() }
    catch (err) { showNotification('error', (err as { response?: { data?: { error?: string } } })?.response?.data?.error || t('Could not save that sender')) }
  }

  const settings = state?.settings
  const totalUnread = state?.groups.reduce((sum, g) => sum + g.unread, 0) || 0

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-md z-[90] flex items-center justify-center p-4 animate-fade" onClick={() => setShowDigestModal(false)}>
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label={t('Digest')}
        className="glass-elevated rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden animate-rise"
      >
        <div className="flex items-start justify-between gap-4 px-5 py-3.5 border-b border-line flex-shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold text-sm text-ink">{t('Digest')}</h2>
            <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
              {settings?.enabled
                ? t('Newsletters wait here instead of your inbox. You get one notification a day, at {time}.', { time: settings.deliverAt })
                : t('Collect newsletters in one place and hear about them once a day, not one at a time.')}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {settings && (
              <button
                role="switch"
                aria-checked={settings.enabled}
                aria-label={settings.enabled ? t('Turn the digest off') : t('Turn the digest on')}
                onClick={() => configure({ enabled: !settings.enabled }, settings.enabled ? t('Digest off — newsletters go to the inbox again') : t('Digest on'))}
                disabled={busy === 'settings'}
                className={`relative flex-shrink-0 w-10 h-6 rounded-full transition-colors disabled:opacity-50 ${settings.enabled ? 'bg-accent' : 'bg-ink/20'}`}
              >
                <span className={`absolute left-0 top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${settings.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
              </button>
            )}
            <button onClick={() => setShowDigestModal(false)} aria-label={t('Close')} className="text-ink-3 hover:text-ink p-1 rounded transition-colors">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
          {loading && <p className="text-xs text-ink-3 py-8 text-center">{t('Loading…')}</p>}

          {settings && (
            <div className="flex items-center gap-3 text-[11.5px] text-ink-2 pb-1">
              <button onClick={() => setShowSettings(v => !v)} className="text-ink-3 hover:text-ink" aria-expanded={showSettings}>
                {showSettings ? '▾' : '▸'} {t('Digest settings')}
              </button>
              <span className="flex-1" />
              {totalUnread > 0 && (
                <button onClick={readAll} disabled={busy === 'read-all'} className="text-info hover:underline disabled:opacity-50">
                  {t('Mark all read')}
                </button>
              )}
            </div>
          )}

          {settings && showSettings && (
            <div className="rounded-xl border border-line/50 bg-ink/4 p-3.5 space-y-3 text-[12px] text-ink-2">
              <label className="flex items-center gap-2">
                <span className="w-36">{t('Deliver at')}</span>
                <input
                  type="time"
                  value={settings.deliverAt}
                  onChange={e => e.target.value && configure({ deliverAt: e.target.value })}
                  className="field px-2 py-1 text-[12px]"
                />
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={settings.autoDetect} onChange={e => configure({ autoDetect: e.target.checked })} />
                <span>{t('Detect newsletters automatically (mail sorted under Promotions). People you have written to and VIPs are never included.')}</span>
              </label>
              <form className="flex gap-2" onSubmit={async e => { e.preventDefault(); if (newSender.trim()) { await setSender(newSender.trim(), 'digest'); setNewSender('') } }}>
                <input
                  value={newSender}
                  onChange={e => setNewSender(e.target.value)}
                  placeholder={t('Always digest: address or @domain')}
                  aria-label={t('Always digest: address or @domain')}
                  className="field flex-1 px-2 py-1 text-[12px]"
                />
                <button className="btn-ghost text-[11.5px] px-3 py-1 rounded-lg">{t('Add')}</button>
              </form>
              <div className="grid grid-cols-2 gap-3">
                {([['Always digest', settings.senders], ['Keep in inbox', settings.excluded]] as const).map(([title, list]) => (
                  <div key={title} className="rounded-lg border border-line/40 p-2 max-h-40 overflow-y-auto">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-ink-3 mb-1">{t(title)}</div>
                    {list.length === 0 && <div className="text-[11px] text-ink-3">—</div>}
                    {list.slice().reverse().map(sender => (
                      <div key={sender} className="group flex items-center gap-1 text-[11.5px] py-0.5">
                        <span className="flex-1 truncate">{sender}</span>
                        <button onClick={() => setSender(sender, 'remove')} title={t('Forget this decision')} className="opacity-0 group-hover:opacity-100 text-ink-3 hover:text-danger px-1">×</button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && settings && !settings.enabled && (state?.groups.length || 0) === 0 && (
            <div className="rounded-xl border border-line/50 bg-ink/4 p-4 text-[12.5px] text-ink-2 leading-relaxed">
              <p className="font-semibold text-ink mb-1">{t('The digest is off')}</p>
              <p>{t('Turn it on and newsletters arriving from now on are filed into a “{folder}” folder. Nothing already in your inbox is moved.', { folder: settings.folder })}</p>
            </div>
          )}

          {!loading && settings?.enabled && state?.groups.length === 0 && (
            <p className="text-xs text-ink-3 py-8 text-center">{t('Nothing waiting. Newsletters will collect here.')}</p>
          )}

          {state?.errors?.map(err => <p key={err.accountId} className="text-[11px] text-danger">{err.email}: {err.error}</p>)}

          {state?.groups.map(group => (
            <div key={group.sender} className="rounded-xl border border-line/50 bg-ink/4 p-3.5">
              <div className="flex items-start gap-3">
                <Avatar from={group.name ? `${group.name} <${group.sender}>` : group.sender} size={32} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-ink truncate">{group.name || group.sender}</span>
                    {group.unread > 0 && <span className="px-1.5 rounded-full text-[10px] font-semibold bg-accent text-[#201500]">{group.unread}</span>}
                  </div>
                  <ul className="mt-1.5 space-y-0.5">
                    {group.emails.slice(0, 5).map(email => (
                      <li key={email.id}>
                        <button onClick={() => open(email)} className="w-full text-left flex items-baseline gap-2 rounded-md px-1.5 py-0.5 hover:bg-ink/6">
                          <span className={`flex-1 truncate text-[11.5px] ${email.read ? 'text-ink-3' : 'text-ink font-medium'}`}>{email.subject || t('(no subject)')}</span>
                          {email.isNew && <span className="text-[9.5px] font-bold uppercase tracking-wider text-accent-ink">{t('New')}</span>}
                          <span className="text-[10px] text-ink-3 flex-shrink-0">{relative(email.date)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {group.count > 5 && <div className="text-[10.5px] text-ink-3 mt-1 px-1.5">{t('and {count} more', { count: group.count - 5 })}</div>}
                </div>
                <button
                  onClick={() => release(group)}
                  disabled={busy === group.sender}
                  className="text-[11px] font-medium px-2.5 py-1.5 rounded-lg text-ink-2 hover:bg-ink/6 disabled:opacity-50 flex-shrink-0"
                  title={t('Not a newsletter: keep this sender in the inbox and move their mail back')}
                >
                  {t('Not a newsletter')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
