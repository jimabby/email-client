import { useMemo } from 'react'
import { useEmailStore } from '../store/emailStore'
import { emailsApi } from '../api/client'

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

  // Deleting a draft also removes its server copy (best-effort) so it doesn't
  // linger in the provider's Drafts folder.
  const removeDraft = (id: string) => {
    const draft = drafts.find(d => d.id === id)
    deleteDraft(id)
    if (draft?.serverRef) emailsApi.deleteServerDraft(draft.accountId, draft.serverRef).catch(() => {})
  }

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
      // Restore the files that were attached when the draft was saved.
      attachments: draft.attachments,
    })
  }

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-md z-[90] flex items-center justify-center p-4 animate-fade" onClick={close}>
      <div onClick={e => e.stopPropagation()} className="glass-elevated rounded-3xl w-[480px] max-h-[70vh] flex flex-col overflow-hidden animate-rise">
        <div className="flex items-center justify-between px-5 py-3 border-b border-line ">
          <h2 className="font-semibold text-sm text-ink ">Drafts {drafts.length > 0 && <span className="text-ink-3 font-normal">({drafts.length})</span>}</h2>
          <button onClick={close} aria-label="Close drafts" className="text-ink-3 hover:text-ink p-1 rounded transition-colors">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {drafts.length === 0 ? (
            <div className="px-5 py-10 text-center text-xs text-ink-3 ">
              No saved drafts. Start a message and click <span className="font-semibold">Save draft</span> to keep it here.
            </div>
          ) : (
            drafts.map(d => (
              <div
                key={d.id}
                onClick={() => openDraft(d.id)}
                className="group flex items-start gap-3 px-5 py-3 border-b border-line/30 cursor-pointer hover:bg-ink/5 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-ink truncate">
                      {d.subject?.trim() || '(no subject)'}
                    </span>
                    <span className="text-[10px] text-ink-3 flex-shrink-0">{formatSaved(d.savedAt)}</span>
                  </div>
                  <div className="text-[11px] text-ink-2 truncate">
                    To: {d.to?.trim() || '—'}
                    {accounts.length > 1 && accountLabel.get(d.accountId) && (
                      <span className="ml-2 text-ink-3 ">· {accountLabel.get(d.accountId)}</span>
                    )}
                  </div>
                  {stripHtml(d.body) && (
                    <div className="text-[11px] text-ink-3 truncate mt-0.5">{stripHtml(d.body)}</div>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); removeDraft(d.id) }}
                  title="Delete draft"
                  className="opacity-0 group-hover:opacity-100 text-ink-3 hover:text-danger p-1 rounded transition-all flex-shrink-0"
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
