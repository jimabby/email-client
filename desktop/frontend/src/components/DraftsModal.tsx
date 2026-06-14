import { useMemo } from 'react'
import { useEmailStore } from '../store/emailStore'

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function formatSaved(iso: string): string {
  try {
    const d = new Date(iso)
    const now = Date.now()
    const diff = now - d.getTime()
    if (diff < 60_000) return 'just now'
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
    return d.toLocaleDateString()
  } catch { return '' }
}

export function DraftsModal() {
  const { drafts, accounts, deleteDraft, setShowDraftsModal, openCompose } = useEmailStore()

  const accountLabel = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of accounts) map.set(a.id, a.name || a.email)
    return map
  }, [accounts])

  const close = () => setShowDraftsModal(false)

  const openDraft = (id: string) => {
    const draft = drafts.find(d => d.id === id)
    if (!draft) return
    close()
    openCompose({
      accountId: draft.accountId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      draftId: draft.id,
    })
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[90] flex items-center justify-center" onClick={close}>
      <div onClick={e => e.stopPropagation()} className="bg-white dark:bg-[#161b22] rounded-xl border border-[#d0d7de] dark:border-[#30363d] shadow-2xl w-[460px] max-h-[70vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#d0d7de] dark:border-[#30363d]">
          <h2 className="font-semibold text-sm text-[#1f2328] dark:text-[#e6edf3]">Drafts {drafts.length > 0 && <span className="text-[#818b98] dark:text-[#484f58] font-normal">({drafts.length})</span>}</h2>
          <button onClick={close} aria-label="Close drafts" className="text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] p-1 rounded transition-colors">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {drafts.length === 0 ? (
            <div className="px-5 py-10 text-center text-xs text-[#818b98] dark:text-[#484f58]">
              No saved drafts. Start a message and click <span className="font-semibold">Save draft</span> to keep it here.
            </div>
          ) : (
            drafts.map(d => (
              <div
                key={d.id}
                onClick={() => openDraft(d.id)}
                className="group flex items-start gap-3 px-5 py-3 border-b border-[#eaeef2] dark:border-[#21262d] cursor-pointer hover:bg-[#f6f8fa] dark:hover:bg-[#1c2128] transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#1f2328] dark:text-[#e6edf3] truncate">
                      {d.subject?.trim() || '(no subject)'}
                    </span>
                    <span className="text-[10px] text-[#818b98] dark:text-[#484f58] flex-shrink-0">{formatSaved(d.savedAt)}</span>
                  </div>
                  <div className="text-[11px] text-[#656d76] dark:text-[#8b949e] truncate">
                    To: {d.to?.trim() || '—'}
                    {accounts.length > 1 && accountLabel.get(d.accountId) && (
                      <span className="ml-2 text-[#818b98] dark:text-[#484f58]">· {accountLabel.get(d.accountId)}</span>
                    )}
                  </div>
                  {stripHtml(d.body) && (
                    <div className="text-[11px] text-[#afb8c1] dark:text-[#484f58] truncate mt-0.5">{stripHtml(d.body)}</div>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteDraft(d.id) }}
                  title="Delete draft"
                  className="opacity-0 group-hover:opacity-100 text-[#818b98] dark:text-[#484f58] hover:text-[#cf222e] dark:hover:text-[#f85149] p-1 rounded transition-all flex-shrink-0"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6L12 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
