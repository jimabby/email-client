import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEmailStore } from '../store/emailStore'
import { useT } from '../lib/i18n'
import { confirmDialog } from './DialogHost'
import { aiApi, emailsApi, withToken } from '../api/client'
import type { EmailSummary } from '../types/email'
import { CategoryTabs } from './CategoryTabs'
import { readJson, writeJson } from '../lib/storage'
import { normalizeSubject, emailDateValue, EmailRow } from './email-list/EmailRow'
import { RECENT_KEY, SAVED_KEY, RECENT_LIMIT, sameSearch } from './email-list/SearchHistory'
import type { SearchEntry } from './email-list/SearchHistory'
import type { Thread, RenderRow } from './email-list/EmailRow'
import { SelectionToolbar } from './email-list/SelectionToolbar'
import { SearchPanel } from './email-list/SearchPanel'

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
  const t = useT()

  const [searchInput, setSearchInput] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [searchMode, setSearchMode] = useState<'email' | 'attachment'>('email')
  const [attachmentType, setAttachmentType] = useState('')
  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({})
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

  // Clicking through the list fires overlapping body fetches. Only the latest
  // may land, or a slow earlier response shows one message's body under
  // another's header.
  const bodyRequestRef = useRef(0)

  const handleSelectEmail = async (email: EmailSummary) => {
    const request = ++bodyRequestRef.current
    setSelectedEmail(email)
    markEmailRead(email.id)
    setLoadingBody(true)
    try {
      // Use the email's own account — search across all accounts can surface
      // results that don't belong to the currently selected account.
      const body = await emailsApi.getBody(email.accountId, email.id, email.folder)
      if (request === bodyRequestRef.current) setSelectedEmailBody(body)
    } catch {
      if (request === bodyRequestRef.current) setSelectedEmailBody(null)
    } finally {
      if (request === bodyRequestRef.current) setLoadingBody(false)
    }
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
        // The map now carries an explicit null for every exhausted account, so
        // its size no longer says anything — only a live token does.
        setNextToken(Object.values(page.nextTokens).some(Boolean) ? 'unified' : null)
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

  // What the stream below needs to know about the current view. Read through a
  // ref so switching folders or accounts does not tear the connection down.
  const liveViewRef = useRef({ currentFolder, currentAccountId, unifiedView, handleRefresh })
  liveViewRef.current = { currentFolder, currentAccountId, unifiedView, handleRefresh }

  // One stream for every account. It used to be one EventSource per account,
  // but a browser allows six HTTP/1.1 connections per origin and each stream
  // holds one for good — with six accounts no API request could get through,
  // and the app hung. The backend multiplexes every account onto this one.
  useEffect(() => {
    if (!accounts.length) return

    const scheduleRefresh = () => {
      if (liveRefreshTimerRef.current) return
      liveRefreshTimerRef.current = window.setTimeout(() => {
        liveRefreshTimerRef.current = null
        liveViewRef.current.handleRefresh().catch(() => {})
      }, 1200)
    }

    // EventSource can't send an Authorization header, so the token rides along
    // as a query parameter (the backend accepts it for stream routes only).
    const es = new EventSource(withToken('/api/emails/stream'))
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type !== 'new-mail') return
        const view = liveViewRef.current
        // In the unified view every account is on screen; otherwise only the
        // selected account's inbox is worth reloading for.
        if (view.currentFolder !== 'INBOX') return
        if (!view.unifiedView && msg.accountId !== view.currentAccountId) return
        scheduleRefresh()
      } catch {
        // Ignore malformed SSE payloads.
      }
    }
    // The browser reconnects an EventSource on its own; nothing to do here
    // beyond keeping the error off the console.
    es.onerror = () => {}

    return () => {
      if (liveRefreshTimerRef.current) {
        window.clearTimeout(liveRefreshTimerRef.current)
        liveRefreshTimerRef.current = null
      }
      es.close()
    }
    // A new account needs its watcher started, which reopening does.
  }, [accounts.length])

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
    const ok = await confirmDialog({
      title: t(selected.length === 1 ? 'Delete {count} email?' : 'Delete {count} emails?', { count: selected.length }),
      body: t('They move to the Trash folder, where the provider will keep them for a while.'),
      confirmLabel: t('Delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await Promise.all(groupSelection(selected).map(g => emailsApi.bulkDelete(g.accountId, g.ids, g.folder)))
      removeFromViews(selected.map(e => e.id))
      showNotification('success', t(selected.length === 1 ? 'Deleted {count} email' : 'Deleted {count} emails', { count: selected.length }))
    } catch { showNotification('error', t('Failed to delete some emails')) }
  }

  const handleBulkMarkRead = async () => {
    const selected = getSelectedEmails()
    if (!selected.length) { clearEmailSelection(); return }
    try {
      await Promise.all(groupSelection(selected).map(g => emailsApi.bulkMarkRead(g.accountId, g.ids, g.folder)))
      const ids = selected.map(e => e.id)
      markEmailsRead(ids)
      if (searchResults) setSearchResults(searchResults.map(e => ids.includes(e.id) ? { ...e, read: true } : e))
    } catch { showNotification('error', t('Failed to mark some emails as read')) }
  }

  const handleBulkMarkUnread = async () => {
    const selected = getSelectedEmails()
    if (!selected.length) { clearEmailSelection(); return }
    try {
      await Promise.all(groupSelection(selected).map(g => emailsApi.bulkMarkUnread(g.accountId, g.ids, g.folder)))
      const ids = selected.map(e => e.id)
      markEmailsUnread(ids)
      if (searchResults) setSearchResults(searchResults.map(e => ids.includes(e.id) ? { ...e, read: false } : e))
    } catch { showNotification('error', t('Failed to mark some emails as unread')) }
  }

  const handleBulkMove = async (targetFolder: string) => {
    const selected = getSelectedEmails()
    if (!selected.length) { clearEmailSelection(); return }
    try {
      await Promise.all(groupSelection(selected).map(g => emailsApi.bulkMove(g.accountId, g.ids, targetFolder, g.folder)))
      removeFromViews(selected.map(e => e.id))
      showNotification('success', t(selected.length === 1 ? 'Moved {count} email to {folder}' : 'Moved {count} emails to {folder}', { count: selected.length, folder: targetFolder }))
    } catch { showNotification('error', t('Failed to move some emails')) }
  }

  const handleBulkArchive = async () => {
    const selected = getSelectedEmails()
    if (!selected.length) { clearEmailSelection(); return }
    try {
      await Promise.all(groupSelection(selected).map(g => emailsApi.bulkMove(g.accountId, g.ids, getArchiveFolder(g.accountId), g.folder)))
      removeFromViews(selected.map(e => e.id))
      showNotification('success', t(selected.length === 1 ? 'Archived {count} email' : 'Archived {count} emails', { count: selected.length }))
    } catch { showNotification('error', t('Failed to archive some emails')) }
  }

  const handleLoadMore = async () => {
    if (!nextToken || isLoadingMore) return
    setLoadingMore(true)
    try {
      if (unifiedView) {
        const page = await emailsApi.unified(currentFolder, 50, unifiedTokens)
        appendEmails(page.emails)
        setUnifiedTokens(page.nextTokens)
        // The map now carries an explicit null for every exhausted account, so
        // its size no longer says anything — only a live token does.
        setNextToken(Object.values(page.nextTokens).some(Boolean) ? 'unified' : null)
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

  // Snoozed emails are hidden everywhere except the Snoozed view (the message
  // physically stays in its folder until it wakes). The unified view shows
  // every account, so it hides every account's snoozes — scoping this to the
  // current account let other accounts' snoozed mail show there.
  const snoozedIdSet = useMemo(
    () => new Set(snoozes.filter(s => unifiedView || s.accountId === currentAccountId).map(s => s.emailId)),
    [snoozes, currentAccountId, unifiedView]
  )
  const snoozedEmails = useMemo(
    () => snoozes
      .filter(s => (unifiedView || s.accountId === currentAccountId) && s.email)
      .sort((a, b) => Date.parse(a.until) - Date.parse(b.until))
      .map(s => s.email as EmailSummary),
    [snoozes, currentAccountId, unifiedView]
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
      showNotification('success', t('That search is already saved'))
      return
    }
    persistSavedSearches([entry, ...savedSearches].slice(0, 50))
    showNotification('success', t('Search saved'))
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

  // The command palette runs saved (and typed) searches through here.
  const applySearchRef = useRef(applySavedSearch)
  applySearchRef.current = applySavedSearch
  useEffect(() => {
    const onRun = (event: Event) => {
      const entry = (event as CustomEvent<SearchEntry>).detail
      if (entry?.query) applySearchRef.current(entry).catch(() => {})
    }
    window.addEventListener('hermes:run-search', onRun)
    return () => window.removeEventListener('hermes:run-search', onRun)
  }, [])

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

  // ─── Keyboard navigation ────────────────────────────────────────────────
  // j/k (from the global shortcut handler) and the arrow keys (while the list
  // has focus) walk the rows in the order they are drawn — threads, category,
  // and priority sort included — so "next" always means the row below.
  const navigableEmails = useMemo(
    () => renderRows.map(row => (row.kind === 'thread' ? row.thread.latest : row.email)),
    [renderRows],
  )
  const navigateRef = useRef<(delta: number) => void>(() => {})
  navigateRef.current = (delta: number) => {
    if (!navigableEmails.length) return
    const current = selectedEmail ? navigableEmails.findIndex(e => e.id === selectedEmail.id) : -1
    const next = current === -1 ? (delta > 0 ? 0 : navigableEmails.length - 1) : current + delta
    if (next >= navigableEmails.length) {
      // Past the last row: fetch the next page rather than stopping dead.
      if (nextToken && !isLoadingMore && !searchResults) handleLoadMore()
      return
    }
    if (next < 0) return
    handleSelectEmail(navigableEmails[next])
    virtualizer.scrollToIndex(next, { align: 'auto' })
  }
  useEffect(() => {
    const onNavigate = (event: Event) => {
      const delta = (event as CustomEvent<{ delta?: number }>).detail?.delta
      if (delta) navigateRef.current(delta)
    }
    window.addEventListener('hermes:navigate', onNavigate)
    return () => window.removeEventListener('hermes:navigate', onNavigate)
  }, [])

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

  const folderLabel = isStarred ? t('Starred')
    : isSnoozed ? t('Snoozed')
    : currentFolder === 'INBOX' ? t('Inbox')
    : currentFolder === 'SENT' ? t('Sent')
    : (currentAccountId && folders[currentAccountId]?.find(f => f.path === currentFolder)?.name) || currentFolder

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-2.5 min-h-[52px] py-2 border-b border-line/40 flex items-center gap-1.5 flex-shrink-0">
        {selectedEmailIds.length > 0 ? (
          <SelectionToolbar
            count={selectedEmailIds.length}
            allSelected={prioritySorted.length > 0 && prioritySorted.every(e => selectedEmailIds.includes(e.id))}
            everySelected={prioritySorted.every(e => selectedEmailIds.includes(e.id))}
            canMove={!!currentAccountId}
            moveTargets={(currentAccountId && folders[currentAccountId] || [
              { name: 'Inbox', path: 'INBOX' }, { name: 'Trash', path: 'Trash' },
              { name: 'Spam', path: 'Spam' }, { name: 'Archive', path: 'Archive' },
            ]).filter(f => f.path !== currentFolder)}
            onToggleAll={handleSelectAll}
            onMarkRead={handleBulkMarkRead}
            onMarkUnread={handleBulkMarkUnread}
            onMove={handleBulkMove}
            onArchive={handleBulkArchive}
            onDelete={handleBulkDelete}
            onClear={clearEmailSelection}
          />
        ) : showSearch ? (
          <SearchPanel search={{ accounts, applySavedSearch, attachmentType, deleteRecentSearch, deleteSavedSearch, handleSearch, isCurrentSearchSaved, persistRecentSearches, recentSearches, saveCurrentSearch, savedSearches, searchAll, searchInput, searchMode, setAttachmentType, setSearchAll, setSearchInput, setSearchMode, setSearchResults, setShowSavedMenu, setShowSearch, showSavedMenu }} />
        ) : (
          <>
            <div className="flex-1 min-w-0 flex items-baseline gap-2 pl-1.5">
              <h2 className="font-semibold text-ink text-[15px] tracking-[-0.015em] truncate">{folderLabel}</h2>
              <span className="text-[11.5px] text-ink-3 tabular-nums flex-shrink-0">
                {searchResults !== null ? t(visibleCount === 1 ? '{count} result' : '{count} results', { count: visibleCount }) : visibleCount || ''}
              </span>
            </div>
            {currentAccountId && !isStarred && !isSnoozed && (
              <button onClick={() => setShowSearch(true)} data-action="search" title={t('Search (/)')} aria-label={t('Search emails…')}
                className="btn-ghost w-8 h-8 flex items-center justify-center">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              </button>
            )}
            {currentAccountId && !isStarred && !isSnoozed && (
              <button onClick={handleRefresh} title={t('Refresh')} aria-label={t('Refresh')}
                className="btn-ghost w-8 h-8 flex items-center justify-center">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className={isLoadingEmails ? 'animate-spin' : ''}><path d="M13.5 8A5.5 5.5 0 112.5 5M2.5 2v3h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            )}
            {currentAccountId && (
              <button
                onClick={toggleThreadView}
                title={threadView ? t('Thread view on') : t('Thread view off')}
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
                title={priorityMode ? t('Priority inbox on') : t('Priority inbox off')}
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

      <div ref={scrollRef} className="flex-1 overflow-y-auto" role="listbox" aria-label={t('Email list')} tabIndex={0} onKeyDown={e => {
        if (e.key === 'Escape' && selectedEmailIds.length > 0) clearEmailSelection()
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          navigateRef.current(e.key === 'ArrowDown' ? 1 : -1)
        }
      }}>
        {isSearching ? (
          <div className="flex items-center justify-center h-24 text-ink-3 text-[12.5px] gap-2">
            <svg className="animate-spin" width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20" strokeDashoffset="5"/></svg>
            {t('Searching…')}
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
                ? t('No results found')
                : !currentAccountId
                ? t('No account selected')
                : isSnoozed
                ? t('Nothing snoozed')
                : isStarred
                ? t('No starred emails')
                : activeCategory !== 'All'
                ? t('No emails in {category}', { category: t(activeCategory) })
                : t('This folder is empty')
              }
            </p>
            <p className="text-ink-3 text-[12.5px] max-w-[220px] leading-relaxed">
              {searchResults !== null
                ? t('Try a different search term or check another folder')
                : !currentAccountId
                ? t('Add an account in Settings to get started')
                : isSnoozed
                ? t('Snooze an email to have it resurface here later')
                : isStarred
                ? t('Star emails to find them quickly here')
                : activeCategory !== 'All'
                ? t('Emails in this category will appear here')
                : t('New emails will appear here when they arrive')
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
                    ? <><svg className="animate-spin" width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20" strokeDashoffset="5"/></svg> {t('Loading…')}</>
                    : t('Load more emails')
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
