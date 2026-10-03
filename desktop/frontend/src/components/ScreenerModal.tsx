import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useEmailStore } from '../store/emailStore'
import { emailsApi } from '../api/client'
import { useT } from '../lib/i18n'
import { Avatar } from './Avatar'
import type { ScreenerGroup, ScreenerState } from '../types/email'

function relative(iso?: string | null) {
  if (!iso) return ''
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }) } catch { return '' }
}

/**
 * Sender screener.
 *
 * With the screener on, mail from someone the user has never written to (and
 * who was not already a contact when it was switched on) waits in a
 * "Screener" folder instead of the inbox. This is where each first-time sender
 * gets one decision: let them in — their waiting mail moves to the inbox and
 * future mail goes straight there — or block them, which bins it all.
 */
export function ScreenerModal() {
  const { setShowScreenerModal, showNotification, setScreenerPending } = useEmailStore()
  const t = useT()
  const [state, setState] = useState<ScreenerState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busySender, setBusySender] = useState<string | null>(null)
  const [toggling, setToggling] = useState(false)
  const [showLists, setShowLists] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await emailsApi.getScreener()
      setState(next)
      setScreenerPending(next.pending.length)
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : t('Could not load the screener'))
    } finally {
      setLoading(false)
    }
  }, [setScreenerPending, showNotification, t])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowScreenerModal(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setShowScreenerModal])

  const toggleEnabled = async () => {
    if (!state) return
    setToggling(true)
    try {
      await emailsApi.configureScreener({ enabled: !state.enabled })
      showNotification('success', state.enabled
        ? t('Screener off — all new mail goes to the inbox')
        : t('Screener on — everyone you already know was approved'))
      await refresh()
      window.dispatchEvent(new CustomEvent('hermes:screener-changed'))
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : t('Could not change the screener'))
    } finally {
      setToggling(false)
    }
  }

  const decide = async (group: ScreenerGroup, decision: 'allow' | 'block', target = group.sender) => {
    setBusySender(group.sender)
    try {
      const result = await emailsApi.decideSender(target, decision)
      showNotification(result.failed ? 'error' : 'success', decision === 'allow'
        ? t('{sender} allowed — {count} moved to the inbox', { sender: target, count: result.moved })
        : t('{sender} blocked — {count} moved to the trash', { sender: target, count: result.moved }))
      await refresh()
      window.dispatchEvent(new CustomEvent('hermes:refresh-list'))
      window.dispatchEvent(new CustomEvent('hermes:screener-changed'))
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : t('Could not save that decision'))
    } finally {
      setBusySender(null)
    }
  }

  const forget = async (sender: string) => {
    try {
      setState(await emailsApi.forgetSender(sender).then(async () => emailsApi.getScreener()))
    } catch {
      showNotification('error', t('Could not remove {sender}', { sender }))
    }
  }

  const domainOf = (sender: string) => {
    const at = sender.indexOf('@')
    return at > 0 ? sender.slice(at) : null
  }

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-md z-[90] flex items-center justify-center p-4 animate-fade" onClick={() => setShowScreenerModal(false)}>
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label={t('Screener')}
        className="glass-elevated rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden animate-rise"
      >
        <div className="flex items-start justify-between gap-4 px-5 py-3.5 border-b border-line flex-shrink-0">
          <div className="min-w-0">
            <h2 className="font-semibold text-sm text-ink">{t('Screener')}</h2>
            <p className="text-[11px] text-ink-3 mt-0.5 leading-relaxed">
              {t('Mail from first-time senders waits here instead of your inbox. Allow a sender once and their mail always comes straight through.')}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {state && (
              <button
                role="switch"
                aria-checked={state.enabled}
                onClick={toggleEnabled}
                disabled={toggling}
                className={`relative flex-shrink-0 w-10 h-6 rounded-full transition-colors disabled:opacity-50 ${state.enabled ? 'bg-accent' : 'bg-ink/20'}`}
                title={state.enabled ? t('Turn the screener off') : t('Turn the screener on')}
              >
                <span className={`absolute left-0 top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${state.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
              </button>
            )}
            <button onClick={() => setShowScreenerModal(false)} aria-label={t('Close')} className="text-ink-3 hover:text-ink p-1 rounded transition-colors">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
          {loading && <p className="text-xs text-ink-3 py-8 text-center">{t('Loading…')}</p>}

          {!loading && state && !state.enabled && (
            <div className="rounded-xl border border-line/50 bg-ink/4 p-4 text-[12.5px] text-ink-2 leading-relaxed">
              <p className="font-semibold text-ink mb-1">{t('The screener is off')}</p>
              <p>{t('Turn it on and everyone you have already exchanged mail with is approved automatically. After that, a new sender’s first message lands in a “{folder}” folder until you decide.', { folder: state.folder })}</p>
            </div>
          )}

          {!loading && state?.enabled && state.pending.length === 0 && (
            <p className="text-xs text-ink-3 py-8 text-center">{t('Nobody is waiting. New senders will show up here.')}</p>
          )}

          {state?.errors?.map(err => (
            <p key={err.accountId} className="text-[11px] text-danger">{err.email}: {err.error}</p>
          ))}

          {state?.pending.map(group => {
            const busy = busySender === group.sender
            const domain = domainOf(group.sender)
            const latest = group.emails[0]
            return (
              <div key={group.sender} className="rounded-xl border border-line/50 bg-ink/4 p-3.5">
                <div className="flex items-start gap-3">
                  <Avatar from={group.name ? `${group.name} <${group.sender}>` : group.sender} size={32} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-semibold text-ink truncate">{group.name || group.sender}</div>
                    {group.name && <div className="text-[11px] text-ink-3 truncate">{group.sender}</div>}
                    <div className="text-[11.5px] text-ink-2 truncate mt-1">
                      {latest?.subject || t('(no subject)')}
                    </div>
                    {latest?.snippet && <div className="text-[11px] text-ink-3 truncate">{latest.snippet}</div>}
                    <div className="text-[10px] text-ink-3 mt-1">
                      {t(group.count === 1 ? '{count} message' : '{count} messages', { count: group.count })} · {relative(group.latest)}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => decide(group, 'allow')}
                        disabled={busy}
                        className="btn-accent text-[11.5px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
                      >
                        {t('Allow')}
                      </button>
                      <button
                        onClick={() => decide(group, 'block')}
                        disabled={busy}
                        className="text-[11.5px] font-medium px-3 py-1.5 rounded-lg text-danger hover:bg-danger/10 disabled:opacity-50"
                      >
                        {t('Block')}
                      </button>
                    </div>
                    {domain && (
                      <div className="flex items-center gap-1 text-[10.5px]">
                        <button onClick={() => decide(group, 'allow', domain)} disabled={busy} className="text-ink-3 hover:text-ink px-1 disabled:opacity-50">
                          {t('Allow all {domain}', { domain })}
                        </button>
                        <span className="text-ink-3">·</span>
                        <button onClick={() => decide(group, 'block', domain)} disabled={busy} className="text-ink-3 hover:text-danger px-1 disabled:opacity-50">
                          {t('Block all')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}

          {state && (state.allowed.length > 0 || state.blocked.length > 0) && (
            <div className="pt-3">
              <button onClick={() => setShowLists(v => !v)} className="text-[11px] text-ink-3 hover:text-ink">
                {showLists ? '▾' : '▸'} {t('Decisions so far: {allowed} allowed, {blocked} blocked', { allowed: state.allowed.length, blocked: state.blocked.length })}
              </button>
              {showLists && (
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {([['Allowed', state.allowed], ['Blocked', state.blocked]] as const).map(([title, list]) => (
                    <div key={title} className="rounded-xl border border-line/50 bg-ink/4 p-2.5 max-h-56 overflow-y-auto">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-ink-3 mb-1.5">{t(title)}</div>
                      {list.length === 0 && <div className="text-[11px] text-ink-3">—</div>}
                      {list.slice().reverse().map(sender => (
                        <div key={sender} className="group flex items-center gap-1 text-[11.5px] text-ink-2 py-0.5">
                          <span className="flex-1 truncate">{sender}</span>
                          <button
                            onClick={() => forget(sender)}
                            title={t('Forget this decision')}
                            className="opacity-0 group-hover:opacity-100 text-ink-3 hover:text-danger px-1"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
