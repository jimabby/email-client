import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { format, isToday, isYesterday, parseISO } from 'date-fns'
import { useEmailStore } from '../store/emailStore'
import { aiApi, emailsApi, withToken } from '../api/client'
import type { EmailSummary } from '../types/email'
import { CategoryTabs } from './CategoryTabs'
import { Avatar } from './Avatar'
import { readJson, writeJson } from '../lib/storage'

function formatDate(dateStr: string): string {
  try {
    const date = parseISO(dateStr)
    if (isToday(date)) return format(date, 'h:mm a')
    if (isYesterday(date)) return 'Yesterday'
    return format(date, 'MMM d')
  } catch { return '' }
}

function getSenderName(from: string): string {
  const match = from.match(/^([^<]+)</)
  if (match) return match[1].trim()
  const emailMatch = from.match(/^<?([^>]+)>?$/)
  if (emailMatch) return emailMatch[1].trim()
  return from
}

function normalizeSubject(subject: string): string {
  const raw = (subject || '').trim().toLowerCase()
  if (!raw) return '(no subject)'
  return raw.replace(/^(re|fw|fwd)\s*:\s*/gi, '').trim() || '(no subject)'
}

function emailDateValue(email: EmailSummary): number {
  const t = Date.parse(email.date)
  return Number.isNaN(t) ? 0 : t
}

function StarBtn({ starred, onClick }: { starred?: boolean; onClick: (e: React.MouseEvent) => void }) {
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

function EmailRow({ email, isSelected, isChecked, onCheck, onClick, onStar, threadCount, threadExpanded, onToggleThread, compact, indent, accountLabel, priorityLabel }: {
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
      aria-label={`${!email.read ? 'Unread: ' : ''}${getSenderName(email.from)} — ${email.subject || '(no subject)'}`}
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
        aria-label={isChecked ? 'Deselect email' : 'Select email'}
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
                title={threadExpanded ? 'Collapse thread' : 'Expand thread'}
                className="p-0.5 text-ink-3 hover:text-ink transition-colors"
              >
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className={`${threadExpanded ? 'rotate-180' : ''} transition-transform duration-200`}>
                  <path d="M2.5 4.5l3.5 3 3.5-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
            <span className={`text-[11px] tabular-nums ${!email.read ? 'text-accent-ink font-medium' : 'text-ink-3'}`}>
              {formatDate(email.date)}
            </span>
          </div>
        </div>

        <div className={`text-[12.5px] truncate mt-px ${!email.read ? 'font-medium text-ink' : 'text-ink-2'}`}>
          {email.subject || '(no subject)'}
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

// A search, as remembered. The same shape backs both the recent list and the
// saved list — what differs is how an entry gets there.
interface SearchEntry {
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

/** One line in the virtualised list, in either display mode. */
type Thread = { key: string; items: EmailSummary[]; latest: EmailSummary; unreadCount: number }
type RenderRow =
  | { kind: 'thread'; key: string; thread: Thread }
  | { kind: 'child'; key: string; email: EmailSummary }
  | { kind: 'flat'; key: string; email: EmailSummary }

const RECENT_KEY = 'hermes-recent-searches'
const SAVED_KEY = 'hermes-saved-searches'
const RECENT_LIMIT = 12

/** Two entries are the same search if every input that shaped it matches. */
function sameSearch(a: SearchEntry, b: SearchEntry): boolean {
  return a.query === b.query
    && a.mode === b.mode
    && a.attachmentType === b.attachmentType
    && a.searchAll === b.searchAll
    && a.accountId === b.accountId
    && a.folder === b.folder
    && a.category === b.category
}

/** One titled group in the search dropdown — Saved or Recent. */
function SearchSection({ title, entries, onApply, onRemove, removeTitle, onClearAll, clearLabel }: {
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

export function EmailList() {
  const {
    emails, isLoadingEmails,
    selectedEmail, setSelectedEmail,
    setSelectedEmailBody, setLoadingBody,
    markEmailRead, currentAccountId, currentFolder,
    emailCategories, setEmailCategories, activeCategory,
    nextToken, setNextToken, isLoadingMore, setLoadingMore, appendEmails,
    searchResults, setSearchResults, isSearching, setIsSearching,
    setEmails, setLoadingEmails,
    toggleStarLocal,
    selectedEmailIds, toggleEmailSelection, clearEmailSelection,
    removeEmails, markEmailsRead, markEmailsUnread,
    folders, showNotification,
    accounts, setCurrentAccount, setCurrentFolder, setActiveCategory,
    threadView, toggleThreadView,
    unifiedView, unifiedTokens, setUnifiedTokens,
    snoozes, getArchiveFolder,
  } = useEmailStore()

  const [searchInput, setSearchInput] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [searchMode, setSearchMode] = useState<'email' | 'attachment'>('email')
  const [attachmentType, setAttachmentType] = useState('')
  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({})
  const [showMoveMenu, setShowMoveMenu] = useState(false)
  const [searchAll, setSearchAll] = useState(false)
  // Two distinct lists. Every search used to be filed as "saved", which meant
  // the saved list was really an unlabelled history the user never asked for
  // and could not curate. Recents accumulate on their own and roll over;
  // saved searches only ever appear because the user pressed Save.
  const [recentSearches, setRecentSearches] = useState<SearchEntry[]>([])
  const [savedSearches, setSavedSearches] = useState<SearchEntry[]>([])
  const [showSavedMenu, setShowSavedMenu] = useState(false)
  const [priorityMode, setPriorityMode] = useState(false)
  const [priorityLoading, setPriorityLoading] = useState(false)
  const [priorityKey, setPriorityKey] = useState('')
  const [priorityMap, setPriorityMap] = useState<Record<string, { score: number; label: string; reason: string }>>({})
  const liveRefreshTimerRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Categorize newly loaded emails
  const lastCategorizedKey = useRef('')
  useEffect(() => {
    if (!emails.length || currentFolder !== 'INBOX') return
    const uncached = emails.filter(e => !emailCategories[e.id])
    if (!uncached.length) return
    const key = uncached.map(e => e.id).join(',')
    if (key === lastCategorizedKey.current) return
    lastCategorizedKey.current = key
    emailsApi.categorize(uncached.map(e => ({ id: e.id, from: e.from, subject: e.subject, snippet: e.snippet })))
      .then(({ categories }) => setEmailCategories(categories as Record<string, any>))
      .catch(() => {})
  }, [emails, currentFolder])

  // Rules run on the server as mail arrives, so the client no longer drives
  // them on every list render. This pass only catches messages that were
  // already in the mailbox before a rule existed; the server skips anything it
  // has processed, so it can't re-fire a destructive action.
  const lastRulesKey = useRef('')
  useEffect(() => {
    if (!emails.length || currentFolder !== 'INBOX') return
    const key = emails.map(e => e.id).join(',')
    if (key === lastRulesKey.current) return
    lastRulesKey.current = key
    emailsApi.runRules(emails).then(({ applied }) => {
      if (!applied.length) return
      const removed = new Set(
        applied.filter(a => ['move', 'archive', 'spam', 'delete'].includes(a.action)).map(a => a.emailId)
      )
      if (removed.size) setEmails(emails.filter(e => !removed.has(e.id)))
      for (const item of applied) if (item.action === 'markRead') markEmailRead(item.emailId)
    }).catch(() => {})
  }, [emails, currentFolder])

  // Clear search when folder changes
  useEffect(() => {
    setSearchInput('')
    setShowSearch(false)
    setSearchResults(null)
    setSearchMode('email')
    setAttachmentType('')
    setSearchAll(false)
  }, [currentFolder, currentAccountId])

  useEffect(() => {
    setExpandedThreads({})
  }, [currentFolder, currentAccountId, searchResults, threadView])

  // Entering the unified view (or changing folder while in it) reloads across
  // every account. The per-account path is driven from the sidebar instead.
  useEffect(() => {
    if (!unifiedView) return
    handleRefresh().catch(() => {})
    // handleRefresh is intentionally omitted: it changes identity on every
    // token update, which would make this loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unifiedView, currentFolder, accounts.length])


  useEffect(() => {
    setSavedSearches(readJson<SearchEntry[]>(SAVED_KEY, []))
    setRecentSearches(readJson<SearchEntry[]>(RECENT_KEY, []))
  }, [])

  const handleSelectEmail = async (email: EmailSummary) => {
    setSelectedEmail(email)
    markEmailRead(email.id)
    setLoadingBody(true)
    try {
      // Use the email's own account — search across all accounts can surface
      // results that don't belong to the currently selected account.
      setSelectedEmailBody(await emailsApi.getBody(email.accountId, email.id, email.folder))
    } catch { setSelectedEmailBody(null) }
    finally { setLoadingBody(false) }
  }

  const handleStar = async (email: EmailSummary, e: React.MouseEvent) => {
    e.stopPropagation()
    const newStarred = !email.starred
    toggleStarLocal(email.id)
    try {
      await emailsApi.star(email.accountId, email.id, newStarred, email.folder)
    } catch {
      toggleStarLocal(email.id) // revert on error
    }
  }

  const handleRefresh = useCallback(async () => {
    if (currentFolder === '__starred__' || currentFolder === '__snoozed__') return
    if (!unifiedView && !currentAccountId) return
    setLoadingEmails(true)
    try {
      if (unifiedView) {
        const page = await emailsApi.unified(currentFolder, 50)
        setEmails(page.emails)
        setUnifiedTokens(page.nextTokens)
        // One unreachable account must not blank the others, so the list still
        // renders and the failure is reported rather than swallowed.
        setNextToken(Object.keys(page.nextTokens).length ? 'unified' : null)
        if (page.errors.length) {
          showNotification('error', `${page.errors[0].email}: ${page.errors[0].error}`)
        }
      } else {
        const { emails: fetched, nextToken: nt } = await emailsApi.list(currentAccountId!, currentFolder)
        setEmails(fetched)
        setNextToken(nt)
      }
    } catch (err) { console.error(err) }
    finally { setLoadingEmails(false) }
  }, [currentAccountId, currentFolder, unifiedView, setLoadingEmails, setEmails, setNextToken, setUnifiedTokens, showNotification])

  useEffect(() => {
    return () => {
      if (liveRefreshTimerRef.current) {
        window.clearTimeout(liveRefreshTimerRef.current)
        liveRefreshTimerRef.current = null
      }
    }
  }, [])

  // One stream per account, not just the selected one. Watching only the
  // current account meant mail arriving on any other account never refreshed
  // anything — and in the unified view that is most of the mailbox.
  useEffect(() => {
    if (!accounts.length) return

    const scheduleRefresh = () => {
      if (liveRefreshTimerRef.current) return
      liveRefreshTimerRef.current = window.setTimeout(() => {
        liveRefreshTimerRef.current = null
        handleRefresh().catch(() => {})
      }, 1200)
    }

    // EventSource can't send an Authorization header, so the token rides along
    // as a query parameter (the backend accepts it for stream routes only).
    const streams = accounts.map(account => {
      const es = new EventSource(withToken(`/api/emails/stream/${account.id}`))
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type !== 'new-mail') return
          // In the unified view every account is on screen; otherwise only the
          // selected account's inbox is worth reloading for.
          if (currentFolder !== 'INBOX') return
          if (!unifiedView && msg.accountId !== currentAccountId) return
          scheduleRefresh()
        } catch {
          // Ignore malformed SSE payloads.
        }
      }
      // The browser reconnects an EventSource on its own; nothing to do here
      // beyond keeping the error off the console.
      es.onerror = () => {}
      return es
    })

    return () => {
      if (liveRefreshTimerRef.current) {
        window.clearTimeout(liveRefreshTimerRef.current)
        liveRefreshTimerRef.current = null
      }
      streams.forEach(es => es.close())
    }
  }, [accounts, currentAccountId, currentFolder, unifiedView, handleRefresh])

  // An undo elsewhere in the app (archive, delete) needs the list to catch up.
  useEffect(() => {
    const onRefresh = () => { handleRefresh().catch(() => {}) }
    window.addEventListener('hermes:refresh-list', onRefresh)
    return () => window.removeEventListener('hermes:refresh-list', onRefresh)
  }, [handleRefresh])

  const handleSearch = async (q: string, opts?: {
    accountId?: string | null
    folder?: string
    mode?: 'email' | 'attachment'
    attachmentType?: string
    searchAll?: boolean
  }) => {
    const qTrim = q.trim()
    if (!qTrim) { setSearchResults(null); return }
    const useAll = opts?.searchAll ?? searchAll
    const accountId = opts?.accountId ?? currentAccountId
    const folder = opts?.folder ?? currentFolder
    const mode = opts?.mode ?? searchMode
    const type = opts?.attachmentType ?? attachmentType
    if (!useAll && !accountId) { setSearchResults(null); return }
    setIsSearching(true)

    // Show local index hits immediately — they come from memory — then merge
    // in the provider results when they land. Supports operators like
    // from:alice, subject:"Q3 report", has:attachment, is:unread.
    const merged = new Map<string, EmailSummary>()
    const publish = () => {
      const list = Array.from(merged.values())
      list.sort((a, b) => emailDateValue(b) - emailDateValue(a))
      setSearchResults(list)
    }

    try {
      if (mode !== 'attachment') {
        try {
          const { emails: local } = await emailsApi.searchIndex(qTrim, {
            accountId: useAll ? null : accountId,
            folder: folder === 'INBOX' ? null : folder,
            limit: 100,
          })
          for (const hit of local) merged.set(hit.id, hit)
          if (merged.size) publish()
        } catch { /* index unavailable — provider results still arrive below */ }
      }

      const results = useAll
        ? (mode === 'attachment'
            ? await emailsApi.searchAttachmentsAll(qTrim, type?.trim(), folder)
            : await Promise.all([
                emailsApi.searchAll(qTrim, folder),
                emailsApi.searchAttachmentsAll(qTrim, type?.trim(), folder),
              ]).then(([a, b]) => [...a, ...b]))
        : (mode === 'attachment'
            ? await emailsApi.searchAttachments(accountId!, qTrim, type?.trim(), folder)
            : await Promise.all([
                emailsApi.search(accountId!, qTrim, folder),
                emailsApi.searchAttachments(accountId!, qTrim, type?.trim(), folder),
              ]).then(([a, b]) => [...a, ...b]))

      for (const r of results) merged.set(r.id, r)
      publish()
      if (!opts) {
        const entry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: qTrim,
          query: qTrim,
          mode,
          attachmentType: type?.trim() || '',
          searchAll: useAll,
          accountId: useAll ? null : accountId,
          folder,
          category: activeCategory,
        }
        setRecentSearches(prev => {
          const next = [entry, ...prev.filter(s => !sameSearch(s, entry))].slice(0, RECENT_LIMIT)
          writeJson(RECENT_KEY, next)
          return next
        })
      }
    } catch {
      // Keep whatever the local index already produced rather than blanking it.
      if (!merged.size) setSearchResults([])
    }
    finally { setIsSearching(false) }
  }

  // Resolve selected emails from whichever list is on screen (search results,
  // snoozed view, or the folder list) so bulk actions work everywhere.
  const getSelectedEmails = () => {
    const pool = searchResults ?? (currentFolder === '__snoozed__' ? snoozedEmails : emails)
    return pool.filter(e => selectedEmailIds.includes(e.id))
  }

  // The bulk endpoints operate per account+folder — cross-account search
  // selections have to be grouped before calling them.
  const groupSelection = (list: EmailSummary[]) => {
    const groups = new Map<string, { accountId: string; folder: string; ids: string[] }>()
    for (const e of list) {
      const key = `${e.accountId}|${e.folder}`
      const g = groups.get(key)
      if (g) g.ids.push(e.id)
      else groups.set(key, { accountId: e.accountId, folder: e.folder, ids: [e.id] })
    }
    return Array.from(groups.values())
  }

  const removeFromViews = (ids: string[]) => {
    removeEmails(ids)
    if (searchResults) setSearchResults(searchResults.filter(e => !ids.includes(e.id)))
  }

  const handleSelectAll = () => {
    const allIds = prioritySorted.map(e => e.id)
    const allSelected = allIds.length > 0 && allIds.every(id => selectedEmailIds.includes(id))
    if (allSelected) {
      clearEmailSelection()
    } else {
      // Select all visible emails
      for (const id of allIds) {
        if (!selectedEmailIds.includes(id)) {
          toggleEmailSelection(id)
        }
      }
    }
  }

  const handleBulkDelete = async () => {
    const selected = getSelectedEmails()
    if (!selected.length) { clearEmailSelection(); return }
    if (!window.confirm(`Delete ${selected.length} email${selected.length > 1 ? 's' : ''}?`)) return
    try {
      await Promise.all(groupSelection(selected).map(g => emailsApi.bulkDelete(g.accountId, g.ids, g.folder)))
      removeFromViews(selected.map(e => e.id))
      showNotification('success', `Deleted ${selected.length} email${selected.length > 1 ? 's' : ''}`)
    } catch { showNotification('error', 'Failed to delete some emails') }
  }

  const handleBulkMarkRead = async () => {
    const selected = getSelectedEmails()
    if (!selected.length) { clearEmailSelection(); return }
    try {
      await Promise.all(groupSelection(selected).map(g => emailsApi.bulkMarkRead(g.accountId, g.ids, g.folder)))
      const ids = selected.map(e => e.id)
      markEmailsRead(ids)
      if (searchResults) setSearchResults(searchResults.map(e => ids.includes(e.id) ? { ...e, read: true } : e))
    } catch { showNotification('error', 'Failed to mark some emails as read') }
  }

  const handleBulkMarkUnread = async () => {
    const selected = getSelectedEmails()
    if (!selected.length) { clearEmailSelection(); return }
    try {
      await Promise.all(selected.map(e => emailsApi.markUnread(e.accountId, e.id, e.folder)))
      const ids = selected.map(e => e.id)
      markEmailsUnread(ids)
      if (searchResults) setSearchResults(searchResults.map(e => ids.includes(e.id) ? { ...e, read: false } : e))
    } catch { showNotification('error', 'Failed to mark some emails as unread') }
  }

  const handleBulkMove = async (targetFolder: string) => {
    const selected = getSelectedEmails()
    if (!selected.length) { clearEmailSelection(); return }
    setShowMoveMenu(false)
    try {
      await Promise.all(groupSelection(selected).map(g => emailsApi.bulkMove(g.accountId, g.ids, targetFolder, g.folder)))
      removeFromViews(selected.map(e => e.id))
      showNotification('success', `Moved ${selected.length} email${selected.length > 1 ? 's' : ''} to ${targetFolder}`)
    } catch { showNotification('error', 'Failed to move some emails') }
  }

  const handleBulkArchive = async () => {
    const selected = getSelectedEmails()
    if (!selected.length) { clearEmailSelection(); return }
    try {
      await Promise.all(groupSelection(selected).map(g => emailsApi.bulkMove(g.accountId, g.ids, getArchiveFolder(g.accountId), g.folder)))
      removeFromViews(selected.map(e => e.id))
      showNotification('success', `Archived ${selected.length} email${selected.length > 1 ? 's' : ''}`)
    } catch { showNotification('error', 'Failed to archive some emails') }
  }

  const handleLoadMore = async () => {
    if (!nextToken || isLoadingMore) return
    setLoadingMore(true)
    try {
      if (unifiedView) {
        const page = await emailsApi.unified(currentFolder, 50, unifiedTokens)
        appendEmails(page.emails)
        setUnifiedTokens(page.nextTokens)
        setNextToken(Object.keys(page.nextTokens).length ? 'unified' : null)
      } else {
        if (!currentAccountId) return
        const { emails: more, nextToken: nt } = await emailsApi.list(currentAccountId, currentFolder, 50, nextToken)
        appendEmails(more)
        setNextToken(nt)
      }
    } catch (err) { console.error(err) }
    finally { setLoadingMore(false) }
  }

  const isInbox = currentFolder === 'INBOX'
  const isStarred = currentFolder === '__starred__'
  const isSnoozed = currentFolder === '__snoozed__'

  // Emails snoozed for the current account are hidden everywhere except the
  // Snoozed view (the message physically stays in its folder until it wakes).
  const snoozedIdSet = useMemo(
    () => new Set(snoozes.filter(s => s.accountId === currentAccountId).map(s => s.emailId)),
    [snoozes, currentAccountId]
  )
  const snoozedEmails = useMemo(
    () => snoozes
      .filter(s => s.accountId === currentAccountId && s.email)
      .sort((a, b) => Date.parse(a.until) - Date.parse(b.until))
      .map(s => s.email as EmailSummary),
    [snoozes, currentAccountId]
  )

  // Starred, from the local index — not just whatever page is loaded.
  const [starredEmails, setStarredEmails] = useState<EmailSummary[]>([])
  useEffect(() => {
    if (!isStarred || !currentAccountId) return
    let cancelled = false
    emailsApi.searchIndex('is:starred', { accountId: currentAccountId, limit: 200 })
      .then(({ emails: found }) => { if (!cancelled) setStarredEmails(found) })
      .catch(() => {
        // Fall back to the loaded page if the index is unavailable.
        if (!cancelled) setStarredEmails(emails.filter(e => e.starred && e.accountId === currentAccountId))
      })
    return () => { cancelled = true }
  }, [isStarred, currentAccountId, emails])

  const persistSavedSearches = (next: SearchEntry[]) => {
    setSavedSearches(next)
    writeJson(SAVED_KEY, next)
  }

  const persistRecentSearches = (next: SearchEntry[]) => {
    setRecentSearches(next)
    writeJson(RECENT_KEY, next)
  }

  // Promote whatever is in the search bar right now into the saved list.
  const saveCurrentSearch = () => {
    const query = searchInput.trim()
    if (!query) return
    const entry: SearchEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: query,
      query,
      mode: searchMode,
      attachmentType: attachmentType.trim(),
      searchAll,
      accountId: searchAll ? null : currentAccountId,
      folder: currentFolder,
      category: activeCategory,
    }
    if (savedSearches.some(s => sameSearch(s, entry))) {
      showNotification('success', 'That search is already saved')
      return
    }
    persistSavedSearches([entry, ...savedSearches].slice(0, 50))
    showNotification('success', 'Search saved')
  }

  const isCurrentSearchSaved = savedSearches.some(s =>
    s.query === searchInput.trim() &&
    s.mode === searchMode &&
    s.searchAll === searchAll
  )

  const applySavedSearch = async (entry: SearchEntry) => {
    setShowSearch(true)
    setSearchInput(entry.query)
    setSearchMode(entry.mode)
    setAttachmentType(entry.attachmentType || '')
    setSearchAll(entry.searchAll)
    if (!entry.searchAll && entry.accountId && entry.accountId !== currentAccountId) {
      setCurrentAccount(entry.accountId)
    }
    if (entry.folder && entry.folder !== currentFolder) {
      setCurrentFolder(entry.folder)
    }
    if (entry.category && entry.category !== activeCategory) {
      setActiveCategory(entry.category as any)
    }
    await handleSearch(entry.query, {
      accountId: entry.accountId,
      folder: entry.folder,
      mode: entry.mode,
      attachmentType: entry.attachmentType,
      searchAll: entry.searchAll,
    })
    setShowSavedMenu(false)
  }

  const deleteSavedSearch = (id: string) => {
    persistSavedSearches(savedSearches.filter(s => s.id !== id))
  }

  const deleteRecentSearch = (id: string) => {
    persistRecentSearches(recentSearches.filter(s => s.id !== id))
  }

  const onRowClick = (email: EmailSummary) => {
    if (selectedEmailIds.length > 0) {
      toggleEmailSelection(email.id)
    } else {
      handleSelectEmail(email)
    }
  }

  const onRowCheck = (email: EmailSummary, e: React.MouseEvent) => {
    e.stopPropagation()
    toggleEmailSelection(email.id)
  }

  const showAccountLabel = unifiedView || (searchAll && searchResults !== null)
  const getPriorityLabel = (id: string) => (priorityMode ? priorityMap[id]?.label : undefined)

  // Determine which list to show.
  // Starred used to filter whatever page happened to be loaded, ignoring the
  // account entirely; it now asks the local index, which covers every message
  // Hermes has seen for this account.
  const baseList = searchResults !== null ? searchResults
    : isSnoozed ? snoozedEmails
    : isStarred ? starredEmails
    : emails

  // Hide snoozed messages from every other view
  const unsnoozedBase = isSnoozed ? baseList : baseList.filter(e => !snoozedIdSet.has(e.id))

  const visibleEmails = isInbox && !searchResults && activeCategory !== 'All'
    ? unsnoozedBase.filter(e => emailCategories[e.id] === activeCategory)
    : unsnoozedBase

  useEffect(() => {
    if (!priorityMode) return
    if (!visibleEmails.length) return
    const key = visibleEmails.map(e => e.id).join(',')
    if (key === priorityKey) return
    setPriorityKey(key)
    setPriorityLoading(true)
    aiApi.rankPriority(visibleEmails.slice(0, 80).map(e => ({
      id: e.id, from: e.from, subject: e.subject, snippet: e.snippet, date: e.date
    })))
      .then(({ scores }) => setPriorityMap(scores || {}))
      .catch((err: unknown) => {
        setPriorityMap({})
        const msg = err instanceof Error ? err.message : 'Priority ranking failed'
        showNotification('error', msg)
      })
      .finally(() => setPriorityLoading(false))
  }, [priorityMode, visibleEmails, priorityKey])

  const prioritySorted = useMemo(() => {
    if (!priorityMode) return visibleEmails
    const list = [...visibleEmails]
    list.sort((a, b) => {
      const sa = priorityMap[a.id]?.score ?? -1
      const sb = priorityMap[b.id]?.score ?? -1
      if (sb !== sa) return sb - sa
      return emailDateValue(b) - emailDateValue(a)
    })
    return list
  }, [visibleEmails, priorityMode, priorityMap])

  const threads = useMemo(() => {
    if (!threadView) return []
    const map = new Map<string, EmailSummary[]>()
    for (const email of prioritySorted) {
      const providerThread = (email.gmailId || email.outlookId) ? email.threadId : null
      const key = `${email.accountId}:${providerThread || normalizeSubject(email.subject)}`
      const items = map.get(key)
      if (items) items.push(email)
      else map.set(key, [email])
    }
    const out = Array.from(map.entries()).map(([key, items]) => {
      items.sort((a, b) => emailDateValue(b) - emailDateValue(a))
      const latest = items[0]
      const unreadCount = items.filter(e => !e.read).length
      return { key, items, latest, unreadCount }
    })
    out.sort((a, b) => emailDateValue(b.latest) - emailDateValue(a.latest))
    return out
  }, [prioritySorted, threadView])

  const visibleCount = threadView ? threads.length : prioritySorted.length

  // Virtualising needs a single flat list. Thread view renders a parent row
  // plus, when expanded, one row per earlier message — so both shapes collapse
  // into this array and the virtualizer never has to know the difference.
  const renderRows = useMemo<RenderRow[]>(() => {
    if (!threadView) {
      return prioritySorted.map(email => ({ kind: 'flat' as const, key: email.id, email }))
    }
    const out: RenderRow[] = []
    for (const thread of threads) {
      out.push({ kind: 'thread', key: thread.key, thread })
      if (expandedThreads[thread.key]) {
        for (const email of thread.items.slice(1)) {
          out.push({ kind: 'child', key: email.id, email })
        }
      }
    }
    return out
  }, [threadView, prioritySorted, threads, expandedThreads])

  const virtualizer = useVirtualizer({
    count: renderRows.length,
    getScrollElement: () => scrollRef.current,
    // Close to a real row. A wrong guess only affects the scrollbar until the
    // row is measured for real by measureElement.
    estimateSize: () => 74,
    overscan: 8,
    getItemKey: (index) => renderRows[index]?.key ?? index,
  })

  // A changed folder, search, or sort should put the user back at the top —
  // otherwise the list keeps a scroll offset that belongs to a different list.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [currentAccountId, currentFolder, searchResults, activeCategory, priorityMode])
  const accountLabelById = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of accounts) map.set(a.id, a.name || a.email)
    return map
  }, [accounts])

  if (isLoadingEmails) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 h-[52px] flex items-center border-b border-line/40">
          <div className="skeleton h-3.5 w-24" />
        </div>
        <div className="p-1.5 space-y-1">
          {[...Array(9)].map((_, i) => (
            <div key={i} className="flex items-start gap-2.5 px-2.5 py-2.5" style={{ opacity: 1 - i * 0.08 }}>
              <div className="skeleton w-[34px] h-[34px] !rounded-full flex-shrink-0" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="skeleton h-2.5 w-1/2" />
                <div className="skeleton h-2.5 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const folderLabel = isStarred ? 'Starred'
    : isSnoozed ? 'Snoozed'
    : currentFolder === 'INBOX' ? 'Inbox'
    : currentFolder === 'SENT' ? 'Sent'
    : currentFolder

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-2.5 min-h-[52px] py-2 border-b border-line/40 flex items-center gap-1.5 flex-shrink-0">
        {selectedEmailIds.length > 0 ? (
          /* Selection toolbar */
          <div className="flex-1 flex items-center gap-1">
            <div
              onClick={handleSelectAll}
              className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center cursor-pointer transition-all mr-1
                ${prioritySorted.length > 0 && prioritySorted.every(e => selectedEmailIds.includes(e.id))
                  ? 'bg-info border-info'
                  : 'border-line '
                }`}
              title={prioritySorted.every(e => selectedEmailIds.includes(e.id)) ? 'Deselect all' : 'Select all'}
            >
              {prioritySorted.length > 0 && prioritySorted.every(e => selectedEmailIds.includes(e.id)) ? (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ) : selectedEmailIds.length > 0 ? (
                <div className="w-2 h-0.5 bg-info rounded" />
              ) : null}
            </div>
            <span className="text-xs font-semibold text-ink mr-1">{selectedEmailIds.length} selected</span>
            <button onClick={handleBulkMarkRead} title="Mark as read"
              className="btn-ghost w-8 h-8 flex items-center justify-center">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1 4l7 5 7-5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/></svg>
            </button>
            <button onClick={handleBulkMarkUnread} title="Mark as unread"
              className="btn-ghost w-8 h-8 flex items-center justify-center">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1 4l7 5 7-5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><circle cx="13" cy="4" r="3" fill="#f59e0b"/></svg>
            </button>
            <div className="relative">
              <button onClick={() => setShowMoveMenu(m => !m)} title="Move to folder"
                className="btn-ghost w-8 h-8 flex items-center justify-center">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1 3.5A1.5 1.5 0 012.5 2h3.44a1 1 0 01.7.29L8 4h5.5A1.5 1.5 0 0115 5.5v7A1.5 1.5 0 0113.5 14h-11A1.5 1.5 0 011 12.5v-9z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
              </button>
              {showMoveMenu && currentAccountId && (
                <div className="absolute left-0 top-full mt-1.5 z-50 glass-elevated rounded-xl py-1.5 min-w-[160px] animate-pop">
                  {(folders[currentAccountId] || [
                    { name: 'Inbox', path: 'INBOX' }, { name: 'Trash', path: 'Trash' },
                    { name: 'Spam', path: 'Spam' }, { name: 'Archive', path: 'Archive' },
                  ]).filter(f => f.path !== currentFolder).map(f => (
                    <button key={f.path} onClick={() => handleBulkMove(f.path)}
                      className="w-full text-left px-3 py-1.5 text-[13px] text-ink hover:bg-ink/6 transition-colors">
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={handleBulkArchive} title="Archive"
              className="btn-ghost w-8 h-8 flex items-center justify-center">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M2 4h12v1H2zM3 5v7a1 1 0 001 1h8a1 1 0 001-1V5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                <path d="M6 8h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </button>
            <button onClick={handleBulkDelete} title="Delete"
              className="btn-ghost w-8 h-8 flex items-center justify-center hover:!text-danger hover:!bg-danger/10">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.5 1h3M2 4h12M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button onClick={clearEmailSelection} title="Deselect all"
              className="btn-ghost ml-auto w-8 h-8 flex items-center justify-center">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </div>
        ) : showSearch ? (
          <div className="flex-1 flex flex-col gap-1.5 relative">
            <div className="flex items-center gap-2">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-ink-3 flex-shrink-0"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              <input
                autoFocus
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onFocus={() => setShowSavedMenu(true)}
                onBlur={() => setTimeout(() => setShowSavedMenu(false), 120)}
                onKeyDown={e => { if (e.key === 'Enter') handleSearch(searchInput); if (e.key === 'Escape') { setShowSearch(false); setSearchInput(''); setSearchResults(null); setSearchMode('email'); setAttachmentType(''); setSearchAll(false); setShowSavedMenu(false) } }}
                placeholder={searchMode === 'attachment' ? 'Attachment name…' : 'Search emails…'}
                className="flex-1 text-[13px] bg-transparent text-ink placeholder-ink-3 focus:outline-none"
              />
              <button
                onClick={() => { setSearchMode(searchMode === 'attachment' ? 'email' : 'attachment'); setAttachmentType('') }}
                title="Search attachments"
                className={`px-2 py-1 text-[10px] rounded-full border transition-colors ${searchMode === 'attachment'
                  ? 'text-ink bg-accent/10 border-accent/40'
                  : 'text-ink-3 border-line hover:text-ink '
                }`}
              >
                Attachments
              </button>
              <button
                onMouseDown={e => e.preventDefault()}
                onClick={saveCurrentSearch}
                disabled={!searchInput.trim() || isCurrentSearchSaved}
                title={isCurrentSearchSaved ? 'Already saved' : 'Save this search'}
                aria-label="Save this search"
                className={`px-2 py-1 text-[10px] rounded-full border transition-colors disabled:opacity-40
                  ${isCurrentSearchSaved
                    ? 'text-accent-ink bg-accent/14 border-accent/40'
                    : 'text-ink-3 border-line/60 hover:text-ink hover:bg-ink/5'
                  }`}
              >
                {isCurrentSearchSaved ? 'Saved' : 'Save'}
              </button>
              <button
                onClick={() => setSearchAll(v => !v)}
                title="Search all accounts"
                className={`px-2 py-1 text-[10px] rounded-full border transition-colors ${searchAll
                  ? 'text-ink bg-info/10 border-info/40'
                  : 'text-ink-3 border-line hover:text-ink '
                }`}
              >
                All accounts
              </button>
              <button onClick={() => { setShowSearch(false); setSearchInput(''); setSearchResults(null); setSearchMode('email'); setAttachmentType(''); setSearchAll(false) }}
                className="text-ink-3 hover:text-danger transition-colors p-0.5 flex-shrink-0">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            </div>
            {searchMode === 'attachment' && (
              <div className="flex items-center gap-2">
                <div className="text-[10px] text-ink-3 ">Type</div>
                <input
                  type="text"
                  value={attachmentType}
                  onChange={e => setAttachmentType(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSearch(searchInput) }}
                  placeholder="pdf, png, image/*"
                  className="flex-1 text-[10.5px] bg-transparent text-ink placeholder-ink-3 focus:outline-none"
                />
              </div>
            )}
            {showSavedMenu && (savedSearches.length > 0 || recentSearches.length > 0) && (
              <div className="absolute left-0 right-0 top-full mt-1.5 z-50 glass-elevated rounded-xl py-1.5 animate-pop max-h-80 overflow-y-auto">
                {savedSearches.length > 0 && (
                  <SearchSection
                    title="Saved"
                    entries={savedSearches}
                    onApply={applySavedSearch}
                    onRemove={deleteSavedSearch}
                    removeTitle="Remove saved search"
                  />
                )}

                {recentSearches.length > 0 && (
                  <SearchSection
                    title="Recent"
                    entries={recentSearches}
                    onApply={applySavedSearch}
                    onRemove={deleteRecentSearch}
                    removeTitle="Remove from recents"
                    onClearAll={() => persistRecentSearches([])}
                    clearLabel="Clear recent searches"
                  />
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="flex-1 min-w-0 flex items-baseline gap-2 pl-1.5">
              <h2 className="font-semibold text-ink text-[15px] tracking-[-0.015em] truncate">{folderLabel}</h2>
              <span className="text-[11.5px] text-ink-3 tabular-nums flex-shrink-0">
                {searchResults !== null ? `${visibleCount} result${visibleCount === 1 ? '' : 's'}` : visibleCount || ''}
              </span>
            </div>
            {currentAccountId && !isStarred && !isSnoozed && (
              <button onClick={() => setShowSearch(true)} title="Search" aria-label="Search emails"
                className="btn-ghost w-8 h-8 flex items-center justify-center">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              </button>
            )}
            {currentAccountId && !isStarred && !isSnoozed && (
              <button onClick={handleRefresh} title="Refresh" aria-label="Refresh emails"
                className="btn-ghost w-8 h-8 flex items-center justify-center">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className={isLoadingEmails ? 'animate-spin' : ''}><path d="M13.5 8A5.5 5.5 0 112.5 5M2.5 2v3h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            )}
            {currentAccountId && (
              <button
                onClick={toggleThreadView}
                title={threadView ? 'Thread view on' : 'Thread view off'}
                aria-pressed={threadView}
                className={`btn-ghost w-8 h-8 flex items-center justify-center ${threadView ? '!text-ink !bg-ink/10' : ''}`}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </button>
            )}
            {currentAccountId && (
              <button
                onClick={() => { setPriorityMode(v => !v); setPriorityKey('') }}
                title={priorityMode ? 'Priority inbox on' : 'Priority inbox off'}
                aria-pressed={priorityMode}
                className={`btn-ghost w-8 h-8 flex items-center justify-center ${priorityMode ? '!text-accent-ink !bg-accent/15' : ''}`}
              >
                {priorityLoading ? (
                  <svg className="animate-spin" width="15" height="15" viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20" strokeDashoffset="5"/>
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                    <path d="M2 13l3-8 3 5 2-3 4 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </button>
            )}
          </>
        )}
      </div>

      {isInbox && !searchResults && <CategoryTabs />}

      <div ref={scrollRef} className="flex-1 overflow-y-auto" role="listbox" aria-label="Email list" tabIndex={0} onKeyDown={e => { if (e.key === 'Escape' && selectedEmailIds.length > 0) clearEmailSelection() }}>
        {isSearching ? (
          <div className="flex items-center justify-center h-24 text-ink-3 text-[12.5px] gap-2">
            <svg className="animate-spin" width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20" strokeDashoffset="5"/></svg>
            Searching…
          </div>
        ) : renderRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <div className="w-14 h-14 rounded-2xl bg-ink/6 flex items-center justify-center mb-4 text-ink-3">
              {searchResults !== null ? (
                <svg width="24" height="24" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              ) : isStarred ? (
                <svg width="24" height="24" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.9 3.8 4.2.6-3 3 .7 4.2L8 10.5l-3.8 2.1.7-4.2-3-3 4.2-.6L8 1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
              ) : activeCategory !== 'All' ? (
                <svg width="24" height="24" viewBox="0 0 16 16" fill="none"><path d="M1 3h14M1 8h10M1 13h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 16 16" fill="none">
                  <path d="M1 10h3l1.5 2h5L12 10h3V13a1 1 0 01-1 1H2a1 1 0 01-1-1v-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                  <path d="M1 10V4a1 1 0 011-1h12a1 1 0 011 1v6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                </svg>
              )}
            </div>
            <p className="text-ink text-[14px] font-medium mb-1.5 tracking-[-0.01em]">
              {searchResults !== null
                ? 'No results found'
                : !currentAccountId
                ? 'No account selected'
                : isSnoozed
                ? 'Nothing snoozed'
                : isStarred
                ? 'No starred emails'
                : activeCategory !== 'All'
                ? `No ${activeCategory.toLowerCase()} emails`
                : 'This folder is empty'
              }
            </p>
            <p className="text-ink-3 text-[12.5px] max-w-[220px] leading-relaxed">
              {searchResults !== null
                ? 'Try a different search term or check another folder'
                : !currentAccountId
                ? 'Add an account in Settings to get started'
                : isSnoozed
                ? 'Snooze an email to have it resurface here later'
                : isStarred
                ? 'Star emails to find them quickly here'
                : activeCategory !== 'All'
                ? 'Emails in this category will appear here'
                : 'New emails will appear here when they arrive'
              }
            </p>
          </div>
        ) : (
          <>
            {/* Only the rows on screen (plus a small overscan) are mounted.
                A 5,000-message folder used to put 5,000 rows in the DOM, each
                with its own avatar and star button. */}
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map(virtualRow => {
                const row = renderRows[virtualRow.index]
                return (
                  <div
                    key={row.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {row.kind === 'thread' ? (
                      <EmailRow
                        email={row.thread.latest}
                        isSelected={selectedEmail?.id === row.thread.latest.id}
                        isChecked={selectedEmailIds.includes(row.thread.latest.id)}
                        onCheck={(e) => onRowCheck(row.thread.latest, e)}
                        onClick={() => onRowClick(row.thread.latest)}
                        onStar={(e) => handleStar(row.thread.latest, e)}
                        threadCount={row.thread.items.length}
                        threadExpanded={!!expandedThreads[row.thread.key]}
                        onToggleThread={(e) => {
                          e.stopPropagation()
                          setExpandedThreads(s => ({ ...s, [row.thread.key]: !s[row.thread.key] }))
                        }}
                        accountLabel={showAccountLabel ? accountLabelById.get(row.thread.latest.accountId) : undefined}
                        priorityLabel={getPriorityLabel(row.thread.latest.id)}
                      />
                    ) : (
                      <EmailRow
                        email={row.email}
                        isSelected={selectedEmail?.id === row.email.id}
                        isChecked={selectedEmailIds.includes(row.email.id)}
                        onCheck={(e) => onRowCheck(row.email, e)}
                        onClick={() => onRowClick(row.email)}
                        onStar={(e) => handleStar(row.email, e)}
                        compact={row.kind === 'child'}
                        indent={row.kind === 'child'}
                        accountLabel={showAccountLabel ? accountLabelById.get(row.email.accountId) : undefined}
                        priorityLabel={getPriorityLabel(row.email.id)}
                      />
                    )}
                  </div>
                )
              })}
            </div>

            {/* Load more */}
            {nextToken && !searchResults && !isStarred && !isSnoozed && (
              <div className="px-4 py-4 flex justify-center">
                <button
                  onClick={handleLoadMore}
                  disabled={isLoadingMore}
                  className="flex items-center gap-1.5 px-5 py-2 text-[12.5px] font-medium text-ink-2 hover:text-ink bg-ink/5 hover:bg-ink/10 rounded-full transition-colors disabled:opacity-50"
                >
                  {isLoadingMore
                    ? <><svg className="animate-spin" width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20" strokeDashoffset="5"/></svg> Loading…</>
                    : 'Load more emails'
                  }
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
