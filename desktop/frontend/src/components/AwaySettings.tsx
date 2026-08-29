import { useEffect, useState } from 'react'
import { emailsApi } from '../api/client'
import { useEmailStore } from '../store/emailStore'
import type { VacationSettings } from '../types/email'

const EMPTY: VacationSettings = {
  enabled: false,
  subject: 'Out of office',
  message: '',
  startAt: null,
  endAt: null,
  accountIds: [],
  knownContactsOnly: false,
  cooldownDays: 4,
}

/** ISO ⇄ the value a datetime-local input wants (no zone, minute precision). */
const toLocalInput = (iso: string | null): string => {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}
const fromLocalInput = (value: string): string | null =>
  value ? new Date(value).toISOString() : null

export function AwaySettings() {
  const { accounts, showNotification } = useEmailStore()
  const [settings, setSettings] = useState<VacationSettings>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)

  useEffect(() => {
    emailsApi.getVacation()
      .then(setSettings)
      .catch(() => showNotification('error', 'Could not load your auto-reply settings'))
      .finally(() => setLoading(false))
  }, [])

  const update = <K extends keyof VacationSettings>(key: K, value: VacationSettings[K]) =>
    setSettings(s => ({ ...s, [key]: value }))

  const save = async () => {
    if (settings.enabled && !settings.message.trim()) {
      showNotification('error', 'Write the message people will receive before turning this on')
      return
    }
    setSaving(true)
    try {
      setSettings(await emailsApi.saveVacation(settings))
      showNotification('success', settings.enabled ? 'Auto-reply is on' : 'Auto-reply is off')
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const runExport = (accountId: string) => {
    setExporting(accountId)
    // A large mailbox streams for a while, so hand the URL to the browser and
    // let it show its own download progress rather than buffering it here.
    window.location.href = emailsApi.exportUrl(accountId, 'INBOX')
    window.setTimeout(() => setExporting(null), 3000)
  }

  if (loading) return <div className="text-[12.5px] text-ink-3">Loading…</div>

  const label = 'block text-[10px] font-semibold text-ink-3 uppercase tracking-wide mb-2'
  const field = 'w-full px-3 py-2 text-sm bg-surface-2 border border-line text-ink placeholder-ink-3 rounded-md focus:outline-none focus:border-accent/60 transition-colors'

  return (
    <div className="space-y-7">
      <section>
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <h3 className="text-[13px] font-semibold text-ink">Vacation auto-reply</h3>
            <p className="text-xs text-ink-2 mt-1 max-w-md leading-relaxed">
              Replies once to each person who writes to you. Runs on the server, so it
              keeps working with Hermes closed.
            </p>
          </div>
          <label className="flex items-center gap-2 shrink-0 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={e => update('enabled', e.target.checked)}
              className="accent-accent"
            />
            <span className="text-[12.5px] text-ink-2">On</span>
          </label>
        </div>

        {settings.active && (
          <p className="mb-3 rounded-lg bg-ok/12 px-3 py-2 text-[12px] text-ok">
            Currently replying to incoming mail.
          </p>
        )}
        {settings.enabled && !settings.active && (
          <p className="mb-3 rounded-lg bg-accent/12 px-3 py-2 text-[12px] text-ink-2">
            Switched on, but outside the dates below — nothing is being sent yet.
          </p>
        )}

        <div className="space-y-3">
          <div>
            <label className={label} htmlFor="away-subject">Subject</label>
            <input
              id="away-subject"
              value={settings.subject}
              onChange={e => update('subject', e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label className={label} htmlFor="away-message">Message</label>
            <textarea
              id="away-message"
              value={settings.message}
              onChange={e => update('message', e.target.value)}
              rows={5}
              placeholder={"I'm away until 3 March and will reply when I'm back.\nFor anything urgent, contact…"}
              className={`${field} resize-none font-sans`}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="away-start">Start</label>
              <input
                id="away-start"
                type="datetime-local"
                value={toLocalInput(settings.startAt)}
                onChange={e => update('startAt', fromLocalInput(e.target.value))}
                className={field}
              />
            </div>
            <div>
              <label className={label} htmlFor="away-end">End</label>
              <input
                id="away-end"
                type="datetime-local"
                value={toLocalInput(settings.endAt)}
                onChange={e => update('endAt', fromLocalInput(e.target.value))}
                className={field}
              />
            </div>
          </div>
          <p className="text-[11.5px] text-ink-3">Leave either blank to run without that limit.</p>

          {accounts.length > 1 && (
            <div>
              <span className={label}>Accounts</span>
              <div className="space-y-1.5">
                {accounts.map(account => (
                  <label key={account.id} className="flex items-center gap-2 text-[12.5px] text-ink-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.accountIds.length === 0 || settings.accountIds.includes(account.id)}
                      onChange={e => {
                        const selected = new Set(
                          settings.accountIds.length ? settings.accountIds : accounts.map(a => a.id),
                        )
                        if (e.target.checked) selected.add(account.id)
                        else selected.delete(account.id)
                        // All-selected is stored as "no restriction", which also
                        // keeps a newly added account covered by default.
                        update('accountIds', selected.size === accounts.length ? [] : Array.from(selected))
                      }}
                      className="accent-accent"
                    />
                    {account.email}
                  </label>
                ))}
              </div>
            </div>
          )}

          <label className="flex items-start gap-2 text-[12.5px] text-ink-2 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.knownContactsOnly}
              onChange={e => update('knownContactsOnly', e.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span>
              Only reply to people I have corresponded with
              <span className="block text-[11.5px] text-ink-3">
                Keeps the auto-reply away from strangers and cold outreach.
              </span>
            </span>
          </label>

          <div>
            <label className={label} htmlFor="away-cooldown">Reply to the same person at most once every</label>
            <div className="flex items-center gap-2">
              <input
                id="away-cooldown"
                type="number"
                min={1}
                max={30}
                value={settings.cooldownDays}
                onChange={e => update('cooldownDays', Number(e.target.value))}
                className={`${field} w-20`}
              />
              <span className="text-[12.5px] text-ink-2">days</span>
            </div>
          </div>

          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-semibold bg-accent text-[#201500] rounded-md disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </section>

      <section className="border-t border-line pt-6">
        <h3 className="text-[13px] font-semibold text-ink">Export your mail</h3>
        <p className="text-xs text-ink-2 mt-1 mb-3 max-w-md leading-relaxed">
          Downloads a folder as an mbox file — the format Thunderbird, Apple Mail, and
          mutt all import. Useful as a backup, and as a way out.
        </p>
        {accounts.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">Add an account first.</p>
        ) : (
          <div className="space-y-1.5">
            {accounts.map(account => (
              <div key={account.id} className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2">
                <span className="text-[12.5px] text-ink-2 truncate">{account.email}</span>
                <button
                  onClick={() => runExport(account.id)}
                  disabled={exporting === account.id}
                  className="shrink-0 text-[12px] font-medium text-accent-ink hover:underline disabled:opacity-50"
                >
                  {exporting === account.id ? 'Preparing…' : 'Export inbox'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
