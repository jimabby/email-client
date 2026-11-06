import { useState } from 'react'
import { useT } from '../../lib/i18n'
import type { Folder } from '../../types/email'

/**
 * The list header while messages are checked: select-all, then the bulk
 * actions. Shown in place of the normal header.
 */
export function SelectionToolbar({
  count, allSelected, everySelected, canMove, moveTargets,
  onToggleAll, onMarkRead, onMarkUnread, onMove, onArchive, onDelete, onClear,
}: {
  count: number
  /** Every visible row is checked (and there is at least one). */
  allSelected: boolean
  /** Every visible row is checked (true for an empty list). */
  everySelected: boolean
  canMove: boolean
  moveTargets: Pick<Folder, 'name' | 'path'>[]
  onToggleAll: () => void
  onMarkRead: () => void
  onMarkUnread: () => void
  onMove: (folder: string) => void
  onArchive: () => void
  onDelete: () => void
  onClear: () => void
}) {
  const t = useT()
  const [showMoveMenu, setShowMoveMenu] = useState(false)
  return (
    <div className="flex-1 flex items-center gap-1">
      <div
        onClick={onToggleAll}
        className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center cursor-pointer transition-all mr-1
          ${allSelected
            ? 'bg-info border-info'
            : 'border-line '
          }`}
        title={everySelected ? t('Deselect all') : t('Select all')}
      >
        {allSelected ? (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        ) : count > 0 ? (
          <div className="w-2 h-0.5 bg-info rounded" />
        ) : null}
      </div>
      <span className="text-xs font-semibold text-ink mr-1">{t('{count} selected', { count: count })}</span>
      <button onClick={onMarkRead} title={t('Mark as read')}
        className="btn-ghost w-8 h-8 flex items-center justify-center">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1 4l7 5 7-5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/></svg>
      </button>
      <button onClick={onMarkUnread} title={t('Mark as unread')}
        className="btn-ghost w-8 h-8 flex items-center justify-center">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1 4l7 5 7-5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><circle cx="13" cy="4" r="3" fill="#f59e0b"/></svg>
      </button>
      <div className="relative">
        <button onClick={() => setShowMoveMenu(m => !m)} title={t('Move to folder')}
          className="btn-ghost w-8 h-8 flex items-center justify-center">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1 3.5A1.5 1.5 0 012.5 2h3.44a1 1 0 01.7.29L8 4h5.5A1.5 1.5 0 0115 5.5v7A1.5 1.5 0 0113.5 14h-11A1.5 1.5 0 011 12.5v-9z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
        </button>
        {showMoveMenu && canMove && (
          <div className="absolute left-0 top-full mt-1.5 z-50 glass-elevated rounded-xl py-1.5 min-w-[160px] animate-pop">
            {moveTargets.map(f => (
              <button key={f.path} onClick={() => { setShowMoveMenu(false); onMove(f.path) }}
                className="w-full text-left px-3 py-1.5 text-[13px] text-ink hover:bg-ink/6 transition-colors">
                {f.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <button onClick={onArchive} title={t('Archive')}
        className="btn-ghost w-8 h-8 flex items-center justify-center">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path d="M2 4h12v1H2zM3 5v7a1 1 0 001 1h8a1 1 0 001-1V5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
          <path d="M6 8h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      </button>
      <button onClick={onDelete} title={t('Delete')}
        className="btn-ghost w-8 h-8 flex items-center justify-center hover:!text-danger hover:!bg-danger/10">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.5 1h3M2 4h12M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      <button onClick={onClear} title={t('Deselect all')}
        className="btn-ghost ml-auto w-8 h-8 flex items-center justify-center">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
      </button>
    </div>
  )
}
