import { useCallback, useEffect, useRef, useState } from 'react'
import { format, isToday, isYesterday, parseISO } from 'date-fns'
import { useEmailStore } from '../store/emailStore'
import { emailsApi } from '../api/client'
import type { EmailSummary } from '../types/email'
import { CategoryTabs } from './CategoryTabs'

function formatDate(dateStr: string): string {
  try {
    const date = parseISO(dateStr)
    if (isToday(date)) return format(date, 'h:mm a')
    if (isYesterday(date)) return 'Yesterday'
    return format(date, 'MMM d')
  } catch { return '' }
}

function getInitials(from: string): string {
  const name = from.replace(/<.*>/, '').trim()
  if (!name) return '?'
  const parts = name.split(' ')
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function getAvatarColor(from: string): string {
  const colors = ['#1d4ed8','#7c3aed','#059669','#d97706','#db2777','#0891b2','#dc2626','#4338ca']
  let hash = 0
  for (const c of from) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff
  return colors[hash % colors.length]
}

function getSenderName(from: string): string {
  const match = from.match(/^([^<]+)</)
  if (match) return match[1].trim()
  const emailMatch = from.match(/^<?([^>]+)>?$/)
  if (emailMatch) return emailMatch[1].trim()
  return from
}

function StarBtn({ starred, onClick }: { starred?: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 transition-all p-0.5 rounded ${starred ? 'opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'}`}
      title={starred ? 'Unstar' : 'Star'}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill={starred ? '#f59e0b' : 'none'}>
        <path d="M8 1l1.9 3.8 4.2.6-3 3 .7 4.2L8 10.5l-3.8 2.1.7-4.2-3-3 4.2-.6L8 1z"
          stroke="#f59e0b" strokeWidth="1.3" strokeLinejoin="round"/>
      </svg>
    </button>
  )
}

function EmailRow({ email, isSelected, isChecked, onCheck, onClick, onStar }: {
  email: EmailSummary
  isSelected: boolean
  isChecked: boolean
  onCheck: (e: React.MouseEvent) => void
  onClick: () => void
  onStar: (e: React.MouseEvent) => void
}) {
  return (
    <div
      onClick={onClick}
      className={`group flex items-start gap-2 px-3 py-2.5 cursor-pointer border-b border-[#eaeef2] dark:border-[#21262d] transition-colors relative
        ${isSelected
          ? 'bg-[#fff8ec] dark:bg-[#1c2128] border-l-[3px] border-l-[#f59e0b]'
          : isChecked
          ? 'bg-[#ddf4ff] dark:bg-[#1c2128] border-l-[3px] border-l-[#0969da]'
          : 'hover:bg-[#f6f8fa] dark:hover:bg-[#161b22] border-l-[3px] border-l-transparent'
        }`}
    >
      {/* Checkbox */}
      <div
        onClick={onCheck}
        className={`flex-shrink-0 mt-2 w-4 h-4 rounded border flex items-center justify-center cursor-pointer transition-all
          ${isChecked
            ? 'bg-[#0969da] border-[#0969da]'
            : 'border-[#d0d7de] dark:border-[#30363d] opacity-0 group-hover:opacity-100'
          }`}
        title={isChecked ? 'Deselect' : 'Select'}
      >
        {isChecked && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </div>

      {/* Avatar */}
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 mt-0.5 ring-2 ring-white dark:ring-[#0d1117]"
        style={{ backgroundColor: getAvatarColor(email.from) }}
      >
        {getInitials(email.from)}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <span className={`text-xs truncate ${!email.read ? 'font-bold text-[#1f2328] dark:text-[#e6edf3]' : 'font-medium text-[#656d76] dark:text-[#8b949e]'}`}>
            {getSenderName(email.from)}
          </span>
          <div className="flex items-center gap-1 flex-shrink-0">
            <StarBtn starred={email.starred} onClick={onStar} />
            <span className={`text-[10px] ${!email.read ? 'text-[#f59e0b] font-semibold' : 'text-[#818b98] dark:text-[#484f58]'}`}>{formatDate(email.date)}</span>
          </div>
        </div>
        <div className={`text-[11.5px] truncate mb-0.5 ${!email.read ? 'font-semibold text-[#24292f] dark:text-[#c9d1d9]' : 'text-[#656d76] dark:text-[#8b949e]'}`}>
          {email.subject || '(no subject)'}
        </div>
        {email.snippet && (
          <div className="text-[11px] text-[#afb8c1] dark:text-[#484f58] truncate leading-tight">{email.snippet}</div>
        )}
      </div>

      {!email.read && !isChecked && (
        <div className="w-2 h-2 rounded-full bg-[#f59e0b] flex-shrink-0 mt-2 shadow-sm shadow-amber-200 dark:shadow-none" />
      )}
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
  } = useEmailStore()

  const [searchInput, setSearchInput] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [showMoveMenu, setShowMoveMenu] = useState(false)
  const liveRefreshTimerRef = useRef<number | null>(null)

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

  // Clear search when folder changes
  useEffect(() => {
    setSearchInput('')
    setShowSearch(false)
    setSearchResults(null)
  }, [currentFolder, currentAccountId])

  const handleSelectEmail = async (email: EmailSummary) => {
    setSelectedEmail(email)
    markEmailRead(email.id)
    if (!currentAccountId) return
    setLoadingBody(true)
    try {
      setSelectedEmailBody(await emailsApi.getBody(currentAccountId, email.id, email.folder))
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
    if (!currentAccountId || currentFolder === '__starred__') return
    setLoadingEmails(true)
    try {
      const { emails: fetched, nextToken: nt } = await emailsApi.list(currentAccountId, currentFolder)
      setEmails(fetched)
      setNextToken(nt)
    } catch (err) { console.error(err) }
    finally { setLoadingEmails(false) }
  }, [currentAccountId, currentFolder, setLoadingEmails, setEmails, setNextToken])

  useEffect(() => {
    return () => {
      if (liveRefreshTimerRef.current) {
        window.clearTimeout(liveRefreshTimerRef.current)
        liveRefreshTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!currentAccountId) return

    const es = new EventSource(`/api/emails/stream/${currentAccountId}`)
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type !== 'new-mail') return
        if (currentFolder !== 'INBOX') return
        if (liveRefreshTimerRef.current) return

        liveRefreshTimerRef.current = window.setTimeout(() => {
          liveRefreshTimerRef.current = null
          handleRefresh().catch(() => {})
        }, 1200)
      } catch {
        // Ignore malformed SSE payloads.
      }
    }

    return () => {
      if (liveRefreshTimerRef.current) {
        window.clearTimeout(liveRefreshTimerRef.current)
        liveRefreshTimerRef.current = null
      }
      es.close()
    }
  }, [currentAccountId, currentFolder, handleRefresh])

  const handleSearch = async (q: string) => {
    if (!currentAccountId || !q.trim()) { setSearchResults(null); return }
    setIsSearching(true)
    try {
      const results = await emailsApi.search(currentAccountId, q.trim(), currentFolder)
      setSearchResults(results)
    } catch { setSearchResults([]) }
    finally { setIsSearching(false) }
  }

  const selectedEmails = emails.filter(e => selectedEmailIds.includes(e.id))
  const selectedVisibleIds = selectedEmails.map(e => e.id)
  const selectedVisibleCount = selectedVisibleIds.length

  const handleBulkDelete = async () => {
    if (!currentAccountId) return
    if (!selectedVisibleCount) { clearEmailSelection(); return }
    try {
      await Promise.all(selectedEmails.map(e => emailsApi.delete(currentAccountId, e.id, e.folder)))
      removeEmails(selectedVisibleIds)
      showNotification('success', `Deleted ${selectedVisibleCount} email${selectedVisibleCount > 1 ? 's' : ''}`)
    } catch { showNotification('error', 'Failed to delete some emails') }
  }

  const handleBulkMarkRead = async () => {
    if (!currentAccountId) return
    if (!selectedVisibleCount) { clearEmailSelection(); return }
    try {
      await Promise.all(selectedEmails.map(e => emailsApi.markRead(currentAccountId, e.id, e.folder)))
      markEmailsRead(selectedVisibleIds)
    } catch { showNotification('error', 'Failed to mark some emails as read') }
  }

  const handleBulkMarkUnread = async () => {
    if (!currentAccountId) return
    if (!selectedVisibleCount) { clearEmailSelection(); return }
    try {
      await Promise.all(selectedEmails.map(e => emailsApi.markUnread(currentAccountId, e.id, e.folder)))
      markEmailsUnread(selectedVisibleIds)
    } catch { showNotification('error', 'Failed to mark some emails as unread') }
  }

  const handleBulkMove = async (targetFolder: string) => {
    if (!currentAccountId) return
    if (!selectedVisibleCount) { clearEmailSelection(); return }
    setShowMoveMenu(false)
    try {
      await Promise.all(selectedEmails.map(e => emailsApi.move(currentAccountId, e.id, targetFolder, e.folder)))
      removeEmails(selectedVisibleIds)
      showNotification('success', `Moved ${selectedVisibleCount} email${selectedVisibleCount > 1 ? 's' : ''} to ${targetFolder}`)
    } catch { showNotification('error', 'Failed to move some emails') }
  }

  const handleLoadMore = async () => {
    if (!currentAccountId || !nextToken || isLoadingMore) return
    setLoadingMore(true)
    try {
      const { emails: more, nextToken: nt } = await emailsApi.list(currentAccountId, currentFolder, 50, nextToken)
      appendEmails(more)
      setNextToken(nt)
    } catch (err) { console.error(err) }
    finally { setLoadingMore(false) }
  }

  const isInbox = currentFolder === 'INBOX'
  const isStarred = currentFolder === '__starred__'

  // Determine which list to show
  const baseList = searchResults !== null ? searchResults
    : isStarred ? emails.filter(e => e.starred)
    : emails

  const visibleEmails = isInbox && !searchResults && activeCategory !== 'All'
    ? baseList.filter(e => emailCategories[e.id] === activeCategory)
    : baseList

  if (isLoadingEmails) {
    return (
      <div className="flex flex-col h-full bg-white dark:bg-[#0d1117]">
        <div className="px-3 py-3 border-b border-[#d0d7de] dark:border-[#30363d]">
          <div className="h-4 bg-[#eaeef2] dark:bg-[#21262d] rounded w-20 animate-pulse" />
        </div>
        {[...Array(8)].map((_, i) => (
          <div key={i} className="flex items-start gap-3 px-3 py-3 border-b border-[#eaeef2] dark:border-[#21262d]">
            <div className="w-8 h-8 rounded-full bg-[#eaeef2] dark:bg-[#21262d] animate-pulse flex-shrink-0" />
            <div className="flex-1">
              <div className="h-2.5 bg-[#eaeef2] dark:bg-[#21262d] rounded w-3/4 animate-pulse mb-2" />
              <div className="h-2.5 bg-[#eaeef2] dark:bg-[#21262d] rounded w-1/2 animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  const folderLabel = isStarred ? 'Starred'
    : currentFolder === 'INBOX' ? 'Inbox'
    : currentFolder === 'SENT' ? 'Sent'
    : currentFolder

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#0d1117]">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-[#d0d7de] dark:border-[#30363d] flex items-center gap-2 flex-shrink-0 bg-[#f6f8fa] dark:bg-[#161b22]">
        {selectedEmailIds.length > 0 ? (
          /* Selection toolbar */
          <div className="flex-1 flex items-center gap-1">
            <span className="text-xs font-semibold text-[#1f2328] dark:text-[#e6edf3] mr-1">{selectedEmailIds.length} selected</span>
            <button onClick={handleBulkMarkRead} title="Mark as read"
              className="p-1.5 text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1 4l7 5 7-5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/></svg>
            </button>
            <button onClick={handleBulkMarkUnread} title="Mark as unread"
              className="p-1.5 text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1 4l7 5 7-5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><circle cx="13" cy="4" r="3" fill="#f59e0b"/></svg>
            </button>
            <div className="relative">
              <button onClick={() => setShowMoveMenu(m => !m)} title="Move to folder"
                className="p-1.5 text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M1 3.5A1.5 1.5 0 012.5 2h3.44a1 1 0 01.7.29L8 4h5.5A1.5 1.5 0 0115 5.5v7A1.5 1.5 0 0113.5 14h-11A1.5 1.5 0 011 12.5v-9z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
              </button>
              {showMoveMenu && currentAccountId && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-[#161b22] border border-[#d0d7de] dark:border-[#30363d] rounded-lg shadow-lg py-1 min-w-[140px]">
                  {(folders[currentAccountId] || [
                    { name: 'Inbox', path: 'INBOX' }, { name: 'Trash', path: 'Trash' },
                    { name: 'Spam', path: 'Spam' }, { name: 'Archive', path: 'Archive' },
                  ]).filter(f => f.path !== currentFolder).map(f => (
                    <button key={f.path} onClick={() => handleBulkMove(f.path)}
                      className="w-full text-left px-3 py-1.5 text-xs text-[#1f2328] dark:text-[#e6edf3] hover:bg-[#f6f8fa] dark:hover:bg-[#21262d] transition-colors">
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={handleBulkDelete} title="Delete"
              className="p-1.5 text-[#656d76] dark:text-[#8b949e] hover:text-[#cf222e] dark:hover:text-[#f85149] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.5 1h3M2 4h12M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button onClick={clearEmailSelection} title="Deselect all"
              className="ml-auto p-1.5 text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </div>
        ) : showSearch ? (
          <div className="flex-1 flex items-center gap-2">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-[#818b98] dark:text-[#484f58] flex-shrink-0"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
            <input
              autoFocus
              type="text"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSearch(searchInput); if (e.key === 'Escape') { setShowSearch(false); setSearchInput(''); setSearchResults(null) } }}
              placeholder="Search emails…"
              className="flex-1 text-xs bg-transparent text-[#1f2328] dark:text-[#e6edf3] placeholder-[#818b98] dark:placeholder-[#484f58] focus:outline-none"
            />
            <button onClick={() => { setShowSearch(false); setSearchInput(''); setSearchResults(null) }}
              className="text-[#818b98] dark:text-[#484f58] hover:text-[#cf222e] dark:hover:text-[#f85149] transition-colors p-0.5 flex-shrink-0">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </div>
        ) : (
          <>
            <h2 className="font-semibold text-[#1f2328] dark:text-[#e6edf3] text-sm flex-1">{folderLabel}</h2>
            {searchResults !== null ? (
              <span className="text-[10px] bg-[#eaeef2] dark:bg-[#21262d] text-[#656d76] dark:text-[#8b949e] px-1.5 py-0.5 rounded-full font-medium">
                {searchResults.length} results
              </span>
            ) : (
              <span className="text-[10px] text-[#afb8c1] dark:text-[#484f58] tabular-nums">{visibleEmails.length}</span>
            )}
            {currentAccountId && !isStarred && (
              <button onClick={() => setShowSearch(true)} title="Search"
                className="p-1.5 text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              </button>
            )}
            {currentAccountId && !isStarred && (
              <button onClick={handleRefresh} title="Refresh"
                className="p-1.5 text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M13.5 8A5.5 5.5 0 112.5 5M2.5 2v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            )}
          </>
        )}
      </div>

      {isInbox && !searchResults && <CategoryTabs />}

      <div className="flex-1 overflow-y-auto">
        {isSearching ? (
          <div className="flex items-center justify-center h-24 text-[#818b98] dark:text-[#484f58] text-xs gap-2">
            <svg className="animate-spin" width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20" strokeDashoffset="5"/></svg>
            Searching…
          </div>
        ) : visibleEmails.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <div className="w-12 h-12 rounded-full bg-[#eaeef2] dark:bg-[#21262d] flex items-center justify-center mb-3 text-[#818b98] dark:text-[#484f58]">
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                <path d="M1 10h3l1.5 2h5L12 10h3V13a1 1 0 01-1 1H2a1 1 0 01-1-1v-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                <path d="M1 10V4a1 1 0 011-1h12a1 1 0 011 1v6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
              </svg>
            </div>
            <p className="text-[#656d76] dark:text-[#8b949e] text-xs">
              {searchResults !== null ? 'No results found' : currentAccountId ? 'No emails in this folder' : 'Select an account to view emails'}
            </p>
          </div>
        ) : (
          <>
            {visibleEmails.map(email => (
              <EmailRow
                key={email.id}
                email={email}
                isSelected={selectedEmail?.id === email.id}
                isChecked={selectedEmailIds.includes(email.id)}
                onCheck={(e) => { e.stopPropagation(); toggleEmailSelection(email.id) }}
                onClick={() => { if (selectedEmailIds.length > 0) { toggleEmailSelection(email.id) } else { handleSelectEmail(email) } }}
                onStar={(e) => handleStar(email, e)}
              />
            ))}

            {/* Load more */}
            {nextToken && !searchResults && !isStarred && (
              <div className="px-4 py-4 flex justify-center">
                <button
                  onClick={handleLoadMore}
                  disabled={isLoadingMore}
                  className="flex items-center gap-1.5 px-5 py-2 text-xs font-medium text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] bg-[#f6f8fa] dark:bg-[#161b22] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] rounded-full transition-colors disabled:opacity-50"
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
