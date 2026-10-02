import { useEffect, useState } from 'react'
import { useEmailStore } from '../store/emailStore'
import { emailsApi } from '../api/client'
import type { NotificationSettings as Settings, MutedThread } from '../types/email'

const inputCls = 'field w-full px-3 py-2 text-[13.5px]'

const DEFAULTS: Settings = {
  vipOnly: false,
  vips: [],
  timeZone: null,
  quietHours: { enabled: false, start: '22:00', end: '07:00', allowVips: true },
}

/** The zone quiet hours are read in — the backend's own clock may be UTC. */
function localZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null } catch { return null }
}

/**
 * VIP senders, quiet hours, and muted conversations. Everything here decides
 * only whether mail interrupts; it still arrives, is searchable, and counts
 * toward the unread badge.
 */
export function NotificationSettings() {
  const { showNotification, accounts, setMutedThreads } = useEmailStore()
  const [settings, setSettings] = useState<Settings>(DEFAULTS)
  const [vipText, setVipText] = useState('')
  const [muted, setMuted] = useState<MutedThread[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    emailsApi.getNotificationSettings()
      .then(s => { setSettings(s); setVipText(s.vips.join('\n')) })
      .catch(() => {})
    emailsApi.getMuted().then(setMuted).catch(() => {})
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const vips = vipText.split(/[\n,;]/).map(v => v.trim()).filter(Boolean)
      const saved = await emailsApi.saveNotificationSettings({ ...settings, vips, timeZone: localZone() })
      setSettings(saved)
      setVipText(saved.vips.join('\n'))
      const dropped = vips.length - saved.vips.length
      showNotification('success', dropped > 0
        ? `Saved — ${dropped} entr${dropped === 1 ? 'y was' : 'ies were'} not an address or domain`
        : 'Notification settings saved')
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Could not save notification settings')
    } finally {
      setSaving(false)
    }
  }

  const unmute = async (item: MutedThread) => {
    try {
      await emailsApi.unmuteThread(item.accountId, item.threadId)
      const list = await emailsApi.getMuted()
      setMuted(list)
      setMutedThreads(list)
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Could not unmute')
    }
  }

  const quiet = settings.quietHours
  const setQuiet = (patch: Partial<Settings['quietHours']>) =>
    setSettings(s => ({ ...s, quietHours: { ...s.quietHours, ...patch } }))

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-[15px] font-semibold text-ink mb-1 tracking-[-0.01em]">VIP senders</h3>
        <p className="text-[12.5px] text-ink-3 mb-3 leading-relaxed">
          One per line: a full address, or <code className="text-ink-2">@company.com</code> for everyone at a domain.
        </p>
        <textarea
          rows={4}
          value={vipText}
          onChange={e => setVipText(e.target.value)}
          placeholder={'boss@company.com\n@family.org'}
          className={`${inputCls} font-mono text-[12.5px]`}
          aria-label="VIP senders"
        />
        <label className="flex items-center gap-2 mt-3 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={settings.vipOnly}
            onChange={e => setSettings(s => ({ ...s, vipOnly: e.target.checked }))}
            className="accent-accent"
          />
          Only notify me about VIP senders
        </label>
      </section>

      <section className="border-t border-line/40 pt-5">
        <h3 className="text-[15px] font-semibold text-ink mb-1 tracking-[-0.01em]">Quiet hours</h3>
        <p className="text-[12.5px] text-ink-3 mb-3 leading-relaxed">
          No notifications on this computer or your phone during these hours
          {localZone() ? <> ({localZone()})</> : null}.
        </p>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={quiet.enabled} onChange={e => setQuiet({ enabled: e.target.checked })} className="accent-accent" />
          Enable quiet hours
        </label>
        <div className={`flex items-center gap-2 mt-3 ${quiet.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
          <span className="text-[12.5px] text-ink-2">From</span>
          <input type="time" value={quiet.start} onChange={e => setQuiet({ start: e.target.value })} className="field px-2 py-1.5 text-[13px]" aria-label="Quiet hours start" />
          <span className="text-[12.5px] text-ink-2">to</span>
          <input type="time" value={quiet.end} onChange={e => setQuiet({ end: e.target.value })} className="field px-2 py-1.5 text-[13px]" aria-label="Quiet hours end" />
        </div>
        <label className={`flex items-center gap-2 mt-3 text-[13px] text-ink ${quiet.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
          <input type="checkbox" checked={quiet.allowVips} onChange={e => setQuiet({ allowVips: e.target.checked })} className="accent-accent" />
          VIP senders still get through
        </label>
      </section>

      <button onClick={save} disabled={saving} className="btn-accent px-4 py-2 rounded-xl text-[13px] font-semibold disabled:opacity-50">
        {saving ? 'Saving…' : 'Save notification settings'}
      </button>

      <section className="border-t border-line/40 pt-5">
        <h3 className="text-[15px] font-semibold text-ink mb-1 tracking-[-0.01em]">Muted conversations</h3>
        <p className="text-[12.5px] text-ink-3 mb-3 leading-relaxed">
          New replies to these skip the inbox and never notify. Mute a conversation from the ⋯ menu when reading it.
        </p>
        {!muted.length && <p className="text-[12px] text-ink-3">Nothing muted.</p>}
        <div className="space-y-1.5">
          {muted.map(item => (
            <div key={`${item.accountId}:${item.threadId}`} className="flex items-center gap-2 rounded-lg border border-line/50 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-ink truncate">{item.subject || '(no subject)'}</div>
                <div className="text-[11px] text-ink-3 truncate">{accounts.find(a => a.id === item.accountId)?.email || ''}</div>
              </div>
              <button onClick={() => unmute(item)} className="text-[11px] px-2 py-1 rounded text-info hover:bg-info/10">Unmute</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
