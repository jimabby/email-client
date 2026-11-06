// A search, as remembered. The same shape backs both the recent list and the
// saved list — what differs is how an entry gets there.
export interface SearchEntry {
  id: string
  name: string
  query: string
  mode: 'email' | 'attachment'
  attachmentType: string
  searchAll: boolean
  accountId: string | null
  folder: string
  category: string
}

export const RECENT_KEY = 'hermes-recent-searches'
export const SAVED_KEY = 'hermes-saved-searches'
export const RECENT_LIMIT = 12

/** Two entries are the same search if every input that shaped it matches. */
export function sameSearch(a: SearchEntry, b: SearchEntry): boolean {
  return a.query === b.query
    && a.mode === b.mode
    && a.attachmentType === b.attachmentType
    && a.searchAll === b.searchAll
    && a.accountId === b.accountId
    && a.folder === b.folder
    && a.category === b.category
}

/** One titled group in the search dropdown — Saved or Recent. */
export function SearchSection({ title, entries, onApply, onRemove, removeTitle, onClearAll, clearLabel }: {
  title: string
  entries: SearchEntry[]
  onApply: (entry: SearchEntry) => void
  onRemove: (id: string) => void
  removeTitle: string
  onClearAll?: () => void
  clearLabel?: string
}) {
  return (
    <div className="pb-1">
      <div className="flex items-center justify-between gap-2 px-3 pt-1 pb-1">
        <span className="text-[10px] font-semibold text-ink-3 uppercase tracking-[0.08em]">{title}</span>
        {onClearAll && (
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={onClearAll}
            className="text-[11px] text-ink-3 hover:text-danger transition-colors"
          >
            {clearLabel}
          </button>
        )}
      </div>
      {entries.map(entry => (
        <div key={entry.id} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-ink/6 transition-colors">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-ink-3 flex-shrink-0">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={() => onApply(entry)}
            className="text-left text-[12.5px] text-ink truncate flex-1"
            title={entry.query}
          >
            {entry.name}
            {entry.searchAll && <span className="ml-1.5 text-[10px] text-ink-3">all accounts</span>}
            {entry.mode === 'attachment' && <span className="ml-1.5 text-[10px] text-ink-3">attachments</span>}
          </button>
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={() => onRemove(entry.id)}
            className="opacity-0 group-hover:opacity-100 text-ink-3 hover:text-danger transition-all p-0.5 flex-shrink-0"
            title={removeTitle}
            aria-label={removeTitle}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
          </button>
        </div>
      ))}
    </div>
  )
}
