import { format, parseISO } from 'date-fns'
import { readJson, writeJson } from '../../lib/storage'
import { htmlToText } from '../../lib/emailHtml'

export function formatFullDate(dateStr: string): string {
  try { return format(parseISO(dateStr), 'EEEE, MMMM d, yyyy h:mm a') }
  catch { return dateStr }
}

export function normalizeSubject(subject: string): string {
  const raw = (subject || '').trim().toLowerCase()
  if (!raw) return '(no subject)'
  return raw.replace(/^(re|fw|fwd)\s*:\s*/gi, '').trim() || '(no subject)'
}

export const stripHtml = htmlToText

/**
 * The id the server can fetch a whole conversation by, or null to fall back
 * to matching subjects in the loaded list. Gmail and Outlook have real
 * conversation ids; an IMAP thread is named by its root Message-ID, which the
 * server searches for across the folder and Sent.
 */
export function serverThreadId(email: { gmailId?: string; outlookId?: string; uid?: number; threadId?: string | null }): string | null {
  if (!email.threadId) return null
  if (email.gmailId || email.outlookId) return email.threadId
  if (email.uid && /^<[^<>\s]+>$/.test(email.threadId)) return email.threadId
  return null
}

// Smart replies were cached one localStorage key per message, which grew
// without bound and could never be pruned. One bounded LRU map instead.
export const SMART_REPLY_KEY = 'hermes-smart-replies'
export const SMART_REPLY_LIMIT = 200

export function readSmartReplyCache(): Record<string, string[]> {
  return readJson<Record<string, string[]>>(SMART_REPLY_KEY, {})
}

export function readSmartReplies(emailId: string): string[] | null {
  const cached = readSmartReplyCache()[emailId]
  return Array.isArray(cached) ? cached : null
}

export function writeSmartReplies(emailId: string, replies: string[]) {
  const cache = readSmartReplyCache()
  cache[emailId] = replies
  const keys = Object.keys(cache)
  for (const stale of keys.slice(0, Math.max(0, keys.length - SMART_REPLY_LIMIT))) delete cache[stale]
  writeJson(SMART_REPLY_KEY, cache)
}

export const StarIcon = ({ filled }: { filled?: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'} className="text-accent">
    <path d="M8 1l1.9 3.8 4.2.6-3 3 .7 4.2L8 10.5l-3.8 2.1.7-4.2-3-3 4.2-.6L8 1z"
      stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
  </svg>
)

/** One row of the reader's overflow menu. */
export function MenuItem({ onClick, label, icon, danger, disabled }: {
  onClick: () => void
  label: string
  icon: React.ReactNode
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-left transition-colors
                  disabled:opacity-50 disabled:cursor-default
        ${danger ? 'text-danger hover:bg-danger/10' : 'text-ink hover:bg-ink/6'}`}
    >
      <span className={`flex-shrink-0 ${danger ? '' : 'text-ink-3'}`}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  )
}
