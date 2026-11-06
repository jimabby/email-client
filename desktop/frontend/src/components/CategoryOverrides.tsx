import { useEffect, useState } from 'react'
import { emailsApi } from '../api/client'
import { useEmailStore } from '../store/emailStore'
import { useT } from '../lib/i18n'

/**
 * The senders the user has sorted into an inbox tab by hand ("Always sort
 * this sender into…" in the reader). They win over both the AI and the
 * built-in rules; removing one hands the sender back to them.
 */
export function CategoryOverrides() {
  const t = useT()
  const showNotification = useEmailStore(s => s.showNotification)
  const [overrides, setOverrides] = useState<{ senders: Record<string, string>; domains: Record<string, string> } | null>(null)

  useEffect(() => {
    emailsApi.getCategoryOverrides().then(setOverrides).catch(() => setOverrides({ senders: {}, domains: {} }))
  }, [])

  const remove = async (key: string, scope: 'sender' | 'domain') => {
    try {
      await emailsApi.removeCategoryOverride(key, scope)
      setOverrides(await emailsApi.getCategoryOverrides())
    } catch {
      showNotification('error', t('Could not remove that rule'))
    }
  }

  const rows = overrides
    ? [
        ...Object.entries(overrides.senders).map(([key, category]) => ({ key, category, scope: 'sender' as const })),
        ...Object.entries(overrides.domains).map(([key, category]) => ({ key, category, scope: 'domain' as const })),
      ].sort((a, b) => a.key.localeCompare(b.key))
    : []

  return (
    <section className="border-t border-line pt-5">
      <h3 className="text-sm font-semibold text-ink mb-1">{t('Inbox tab rules')}</h3>
      <p className="text-[11px] text-ink-3 mb-2">
        {t('Senders you have sorted by hand with “Always sort this sender into…”. These win over automatic sorting.')}
      </p>
      {overrides && rows.length === 0 && <p className="text-[11.5px] text-ink-3">{t('None yet.')}</p>}
      <div className="space-y-0.5">
        {rows.map(row => (
          <div key={`${row.scope}:${row.key}`} className="group flex items-center gap-2 text-[12px] text-ink-2 px-2 py-1 rounded-md hover:bg-ink/4">
            <span className="flex-1 truncate">{row.scope === 'domain' ? t('Everyone at {domain}', { domain: row.key }) : row.key}</span>
            <span className="text-ink-3">→ {t(row.category)}</span>
            <button onClick={() => remove(row.key, row.scope)} className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-ink-3 hover:text-danger px-1" aria-label={t('Remove')}>×</button>
          </div>
        ))}
      </div>
    </section>
  )
}
