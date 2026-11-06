import { format, isToday, isYesterday, parseISO } from 'date-fns'
import { t as translate } from '../../lib/i18n'
import type { EmailSummary } from '../../types/email'
import { Avatar } from '../Avatar'

/** One line in the virtualised list, in either display mode. */
export type Thread = { key: string; items: EmailSummary[]; latest: EmailSummary; unreadCount: number }
export type RenderRow =
  | { kind: 'thread'; key: string; thread: Thread }
  | { kind: 'child'; key: string; email: EmailSummary }
  | { kind: 'flat'; key: string; email: EmailSummary }



export function formatDate(dateStr: string): string {
  try {
    const date = parseISO(dateStr)
    if (isToday(date)) return format(date, 'h:mm a')
    if (isYesterday(date)) return 'Yesterday'
    return format(date, 'MMM d')
  } catch { return '' }
}

export function getSenderName(from: string): string {
  const match = from.match(/^([^<]+)</)
  if (match) return match[1].trim()
  const emailMatch = from.match(/^<?([^>]+)>?$/)
  if (emailMatch) return emailMatch[1].trim()
  return from
}

export function normalizeSubject(subject: string): string {
  const raw = (subject || '').trim().toLowerCase()
  if (!raw) return '(no subject)'
  return raw.replace(/^(re|fw|fwd)\s*:\s*/gi, '').trim() || '(no subject)'
}

export function emailDateValue(email: EmailSummary): number {
  const t = Date.parse(email.date)
  return Number.isNaN(t) ? 0 : t
}

export function StarBtn({ starred, onClick }: { starred?: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 p-0.5 rounded-md text-accent transition-all duration-150 active:scale-90
        ${starred ? 'opacity-100' : 'opacity-0 group-hover:opacity-50 hover:!opacity-100'}`}
      title={starred ? 'Unstar' : 'Star'}
      aria-label={starred ? 'Unstar' : 'Star'}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill={starred ? 'currentColor' : 'none'}>
        <path d="M8 1l1.9 3.8 4.2.6-3 3 .7 4.2L8 10.5l-3.8 2.1.7-4.2-3-3 4.2-.6L8 1z"
          stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
      </svg>
    </button>
  )
}

export function EmailRow({ email, isSelected, isChecked, onCheck, onClick, onStar, threadCount, threadExpanded, onToggleThread, compact, indent, accountLabel, priorityLabel }: {
  email: EmailSummary
  isSelected: boolean
  isChecked: boolean
  onCheck: (e: React.MouseEvent) => void
  onClick: () => void
  onStar: (e: React.MouseEvent) => void
  threadCount?: number
  threadExpanded?: boolean
  onToggleThread?: (e: React.MouseEvent) => void
  compact?: boolean
  indent?: boolean
  accountLabel?: string
  priorityLabel?: string
}) {
  return (
    <div
      onClick={onClick}
      role="option"
      aria-selected={isSelected}
      aria-label={`${!email.read ? `${translate('Unread')}: ` : ''}${getSenderName(email.from)} — ${email.subject || translate('(no subject)')}`}
      className={`group relative flex items-start gap-2.5 mx-1.5 rounded-xl cursor-pointer
                  ${indent ? 'pl-9 pr-3' : 'px-2.5'} ${compact ? 'py-2' : 'py-2.5'}
                  transition-[background-color,box-shadow] duration-150
        ${isSelected
          ? 'bg-accent/14 shadow-[inset_0_0_0_1px_rgb(var(--accent)/0.28)]'
          : isChecked
          ? 'bg-info/12 shadow-[inset_0_0_0_1px_rgb(var(--info)/0.30)]'
          : 'hover:bg-ink/5'
        }`}
    >
      {/* Unread marker — a soft bar on the leading edge, rather than a dot
          competing with the avatar for attention. */}
      {!email.read && !isChecked && (
        <div className="absolute left-1 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-full bg-accent" aria-hidden />
      )}

      {/* Checkbox */}
      <div
        onClick={onCheck}
        role="checkbox"
        aria-checked={isChecked}
        aria-label={isChecked ? translate('Deselect email') : translate('Select email')}
        className={`flex-shrink-0 mt-1.5 w-[17px] h-[17px] rounded-[6px] border flex items-center justify-center
                    cursor-pointer transition-all duration-150
          ${isChecked
            ? 'bg-info border-info'
            : 'border-line opacity-0 group-hover:opacity-100 hover:border-ink-3'
          }`}
      >
        {isChecked && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </div>

      {/* Avatar */}
      <Avatar from={email.from} size={compact ? 28 : 34} className="mt-px" />

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-[13px] truncate tracking-[-0.005em] ${!email.read ? 'font-semibold text-ink' : 'text-ink-2'}`}>
            {getSenderName(email.from)}
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <StarBtn starred={email.starred} onClick={onStar} />
            {accountLabel && (
              <span className="text-[10px] px-1.5 py-px rounded-full bg-ink/10 text-ink-2">
                {accountLabel}
              </span>
            )}
            {typeof threadCount === 'number' && threadCount > 1 && onToggleThread && (
              <button
                onClick={onToggleThread}
                title={threadExpanded ? translate('Collapse thread') : translate('Expand thread')}
                className="p-0.5 text-ink-3 hover:text-ink transition-colors"
              >
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className={`${threadExpanded ? 'rotate-180' : ''} transition-transform duration-200`}>
                  <path d="M2.5 4.5l3.5 3 3.5-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
            {email.hasAttachments && (
              <span title={translate('Has attachments')} aria-label={translate('Has attachments')} className="text-ink-3 flex-shrink-0">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M10 4L6 8.5a2 2 0 01-3-2.5L8 1a3 3 0 014 4.5L5.5 11A4 4 0 01.5 5.5L6 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              </span>
            )}
            <span className={`text-[11px] tabular-nums ${!email.read ? 'text-accent-ink font-medium' : 'text-ink-3'}`}>
              {formatDate(email.date)}
            </span>
          </div>
        </div>

        <div className={`text-[12.5px] truncate mt-px ${!email.read ? 'font-medium text-ink' : 'text-ink-2'}`}>
          {email.subject || translate('(no subject)')}
          {typeof threadCount === 'number' && threadCount > 1 && (
            <span className="ml-1.5 text-[10px] px-1.5 py-px rounded-full bg-ink/10 text-ink-2 align-middle">
              {threadCount}
            </span>
          )}
          {priorityLabel && (
            <span className="ml-1.5 text-[10px] px-1.5 py-px rounded-full bg-accent/20 text-accent-ink font-medium align-middle">
              {priorityLabel}
            </span>
          )}
        </div>

        {email.snippet && (
          <div className="text-[12px] text-ink-3 truncate leading-snug mt-0.5">{email.snippet}</div>
        )}
      </div>
    </div>
  )
}
