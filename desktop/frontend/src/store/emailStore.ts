import { create } from 'zustand'
import type {
  Account, EmailSummary, EmailBody, Folder, ComposeData, EmailCategory, SnoozeItem,
  Draft, UnreadCounts, OutboxItem, Alias,
} from '../types/email'
import { readJson, writeJson, writeListWithinQuota } from '../lib/storage'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function readThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem('hermes-theme')
    return raw === 'light' || raw === 'dark' ? raw : 'system'
  } catch {
    return 'system'
  }
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}

interface EmailStore {
  // Accounts
  accounts: Account[]
  setAccounts: (accounts: Account[]) => void
  addAccount: (account: Account) => void
  removeAccount: (id: string) => void

  // Navigation
  currentAccountId: string | null
  currentFolder: string
  /**
   * When set, the list shows every account merged into one date-ordered view.
   * currentAccountId stays pointed at the last real account so compose, folder
   * lists, and account-scoped actions still have something to work with.
   */
  unifiedView: boolean
  setUnifiedView: (on: boolean) => void
  /**
   * Per-account continuation tokens for the unified list. A null value means
   * that account is exhausted and must not be re-fetched from the top.
   */
  unifiedTokens: Record<string, string | null>
  setUnifiedTokens: (tokens: Record<string, string | null>) => void
  setCurrentAccount: (id: string | null) => void
  setCurrentFolder: (folder: string) => void

  // Folders
  folders: Record<string, Folder[]>
  setFolders: (accountId: string, folders: Folder[]) => void
  // Resolve the best "archive" destination for an account from its real folder
  // list (Gmail IMAP has no "Archive" folder — it uses "[Gmail]/All Mail").
  getArchiveFolder: (accountId: string) => string

  // Real per-folder unread totals from the provider (not a count of the
  // currently loaded page).
  unreadCounts: UnreadCounts
  setUnreadCounts: (counts: UnreadCounts) => void
  getUnreadCount: (accountId: string, folder: string) => number

  // Outbox
  outbox: OutboxItem[]
  setOutbox: (items: OutboxItem[]) => void
  showOutboxModal: boolean
  setShowOutboxModal: (show: boolean) => void

  // Send-as aliases, keyed by account id
  aliases: Record<string, Alias[]>
  setAliases: (accountId: string, aliases: Alias[]) => void

  // Emails list
  emails: EmailSummary[]
  isLoadingEmails: boolean
  setEmails: (emails: EmailSummary[]) => void
  appendEmails: (emails: EmailSummary[]) => void
  setLoadingEmails: (loading: boolean) => void
  markEmailRead: (id: string) => void
  markEmailUnread: (id: string) => void
  removeEmail: (id: string) => void
  removeEmails: (ids: string[]) => void
  markEmailsRead: (ids: string[]) => void
  markEmailsUnread: (ids: string[]) => void
  toggleStarLocal: (id: string) => void

  // Multi-select
  selectedEmailIds: string[]
  toggleEmailSelection: (id: string) => void
  clearEmailSelection: () => void

  // Pagination
  nextToken: string | null
  setNextToken: (token: string | null) => void
  isLoadingMore: boolean
  setLoadingMore: (v: boolean) => void

  // Search
  searchResults: EmailSummary[] | null
  setSearchResults: (results: EmailSummary[] | null) => void
  isSearching: boolean
  setIsSearching: (v: boolean) => void

  // Selected email
  selectedEmail: EmailSummary | null
  selectedEmailBody: EmailBody | null
  isLoadingBody: boolean
  setSelectedEmail: (email: EmailSummary | null) => void
  setSelectedEmailBody: (body: EmailBody | null) => void
  setLoadingBody: (loading: boolean) => void

  // Compose
  isComposeOpen: boolean
  composeData: ComposeData | null
  // Bumped on every openCompose so the modal remounts with fresh fields even
  // when a compose window is already open (e.g. Reply while composing).
  composeNonce: number
  openCompose: (data?: Partial<ComposeData>) => void
  closeCompose: () => void

  // UI
  showAccountModal: boolean
  setShowAccountModal: (show: boolean) => void
  notification: { type: 'success' | 'error'; message: string; action?: { label: string; onClick: () => void } } | null
  showNotification: (
    type: 'success' | 'error',
    message: string,
    options?: { action?: { label: string; onClick: () => void }; timeoutMs?: number }
  ) => void
  clearNotification: () => void

  // AI
  aiProvider: 'claude' | 'openai' | 'gemini' | null
  aiConfigured: boolean
  setAiConfig: (provider: 'claude' | 'openai' | 'gemini' | null, configured: boolean) => void

  // Categorization
  emailCategories: Record<string, EmailCategory>
  activeCategory: EmailCategory
  setEmailCategories: (categories: Record<string, EmailCategory>) => void
  setActiveCategory: (category: EmailCategory) => void

  // Daily report
  pendingReport: { subject: string; html: string; text: string } | null
  setPendingReport: (report: { subject: string; html: string; text: string } | null) => void
  clearPendingReport: () => void

  // Signature (localStorage-persisted) — per-account + global fallback
  signature: string
  setSignature: (sig: string) => void
  accountSignatures: Record<string, string>
  setAccountSignature: (accountId: string, sig: string) => void
  getSignatureForAccount: (accountId: string) => string
  /**
   * The signature for the identity actually being sent from. Aliases are
   * honoured at send time by every provider, but the signature stayed global —
   * so mail sent from a second identity was signed as the first.
   *
   * Resolution order: this alias, then the account, then the global default.
   */
  getSignatureFor: (accountId: string, aliasEmail?: string | null) => string
  setAliasSignature: (accountId: string, aliasEmail: string, sig: string) => void

  // Contacts autocomplete (localStorage-persisted)
  contacts: string[]
  addContacts: (addresses: string[]) => void

  // Snooze
  snoozes: SnoozeItem[]
  setSnoozes: (snoozes: SnoozeItem[]) => void
  snoozeEmailLocal: (email: EmailSummary, until: string) => void
  unsnoozeLocal: (emailId: string) => void

  // Drafts (localStorage-persisted)
  drafts: Draft[]
  saveDraft: (draft: Draft) => void
  deleteDraft: (id: string) => void
  showDraftsModal: boolean
  setShowDraftsModal: (show: boolean) => void

  // Rules editor
  showRulesModal: boolean
  setShowRulesModal: (show: boolean) => void

  // AI Chat
  isChatOpen: boolean
  toggleChat: () => void

  // Undo send. Every send goes through the server queue, so a message with an
  // undo window is genuinely recallable until `canUndoUntil` passes — this is
  // what puts a visible countdown on that window.
  pendingSend: { jobId: string; accountId: string; canUndoUntil: string; subject: string; windowSec: number } | null
  setPendingSend: (send: EmailStore['pendingSend']) => void
  clearPendingSend: () => void

  // Privacy — contact avatars are fetched from Gravatar, which discloses a
  // hash of every correspondent's address to a third party. Off by default.
  gravatarEnabled: boolean
  setGravatarEnabled: (enabled: boolean) => void

  /**
   * Theme.
   *
   * `themePreference` is what the user chose; `theme` is what is actually
   * painted. They differ under 'system', which follows the OS and changes
   * without any interaction — the old store had only the second, defaulted to
   * dark, and never consulted prefers-color-scheme, so the whole light palette
   * was unreachable for anyone who did not go looking for the toggle.
   */
  themePreference: ThemePreference
  theme: ResolvedTheme
  setThemePreference: (preference: ThemePreference) => void
  toggleTheme: () => void
  /** Called by the OS media-query listener; ignored unless preference is 'system'. */
  syncSystemTheme: (systemTheme: ResolvedTheme) => void

  // Thread view
  threadView: boolean
  toggleThreadView: () => void
}

export const useEmailStore = create<EmailStore>((set, get) => ({
  accounts: [],
  setAccounts: (accounts) => set({ accounts }),
  addAccount: (account) => set((s) => ({ accounts: [...s.accounts, account] })),
  removeAccount: (id) => set((s) => ({ accounts: s.accounts.filter(a => a.id !== id) })),

  currentAccountId: null,
  currentFolder: 'INBOX',
  unifiedView: false,
  unifiedTokens: {},
  setUnifiedView: (on) => set({
    unifiedView: on,
    selectedEmail: null,
    selectedEmailBody: null,
    nextToken: null,
    unifiedTokens: {},
    searchResults: null,
    selectedEmailIds: [],
  }),
  setUnifiedTokens: (tokens) => set({ unifiedTokens: tokens }),
  // Choosing a specific account leaves the unified view — the two are
  // alternatives, and staying in both at once is what would make the folder
  // list and the message list disagree.
  setCurrentAccount: (id) => set({ currentAccountId: id, unifiedView: false, unifiedTokens: {}, selectedEmail: null, selectedEmailBody: null, nextToken: null, searchResults: null, selectedEmailIds: [] }),
  setCurrentFolder: (folder) => set({ currentFolder: folder, unifiedTokens: {}, selectedEmail: null, selectedEmailBody: null, nextToken: null, searchResults: null, selectedEmailIds: [] }),

  folders: {},
  setFolders: (accountId, folders) => set((s) => ({ folders: { ...s.folders, [accountId]: folders } })),
  getArchiveFolder: (accountId) => {
    const fl = get().folders[accountId] || []
    const match =
      fl.find(f => /^archive$/i.test(f.name) || /archive/i.test(f.path)) ||
      fl.find(f => /all mail/i.test(f.name) || /all mail/i.test(f.path))
    return match?.path || 'Archive'
  },

  unreadCounts: {},
  setUnreadCounts: (counts) => set({ unreadCounts: counts }),
  getUnreadCount: (accountId, folder) => get().unreadCounts[accountId]?.[folder]?.unread ?? 0,

  outbox: [],
  setOutbox: (items) => set({ outbox: items }),
  showOutboxModal: false,
  setShowOutboxModal: (show) => set({ showOutboxModal: show }),

  aliases: {},
  setAliases: (accountId, aliases) => set((s) => ({ aliases: { ...s.aliases, [accountId]: aliases } })),

  emails: [],
  isLoadingEmails: false,
  setEmails: (emails) => set({ emails }),
  // De-duplicated by id. A page boundary can legitimately re-deliver a
  // message (an account that ran out of pages, a provider that overlaps its
  // cursors), and appending blindly produced duplicate rows sharing a React
  // key. Existing entries win so local optimistic state is not clobbered.
  appendEmails: (emails) => set((s) => {
    const seen = new Set(s.emails.map(e => e.id))
    const fresh = emails.filter(e => e?.id && !seen.has(e.id))
    return fresh.length ? { emails: [...s.emails, ...fresh] } : {}
  }),
  setLoadingEmails: (loading) => set({ isLoadingEmails: loading }),
  markEmailRead: (id) => set((s) => ({
    emails: s.emails.map(e => e.id === id ? { ...e, read: true } : e)
  })),
  markEmailUnread: (id) => set((s) => ({
    emails: s.emails.map(e => e.id === id ? { ...e, read: false } : e)
  })),
  removeEmail: (id) => set((s) => ({
    emails: s.emails.filter(e => e.id !== id),
    selectedEmail: s.selectedEmail?.id === id ? null : s.selectedEmail,
    selectedEmailBody: s.selectedEmail?.id === id ? null : s.selectedEmailBody,
  })),
  removeEmails: (ids) => set((s) => {
    const set_ = new Set(ids)
    return {
      emails: s.emails.filter(e => !set_.has(e.id)),
      selectedEmail: set_.has(s.selectedEmail?.id ?? '') ? null : s.selectedEmail,
      selectedEmailBody: set_.has(s.selectedEmail?.id ?? '') ? null : s.selectedEmailBody,
      selectedEmailIds: [],
    }
  }),
  markEmailsRead: (ids) => set((s) => {
    const set_ = new Set(ids)
    return { emails: s.emails.map(e => set_.has(e.id) ? { ...e, read: true } : e), selectedEmailIds: [] }
  }),
  markEmailsUnread: (ids) => set((s) => {
    const set_ = new Set(ids)
    return { emails: s.emails.map(e => set_.has(e.id) ? { ...e, read: false } : e), selectedEmailIds: [] }
  }),
  toggleStarLocal: (id) => set((s) => ({
    emails: s.emails.map(e => e.id === id ? { ...e, starred: !e.starred } : e),
    selectedEmail: s.selectedEmail?.id === id ? { ...s.selectedEmail, starred: !s.selectedEmail.starred } : s.selectedEmail,
  })),

  nextToken: null,
  setNextToken: (token) => set({ nextToken: token }),
  isLoadingMore: false,
  setLoadingMore: (v) => set({ isLoadingMore: v }),

  searchResults: null,
  setSearchResults: (results) => set({ searchResults: results }),
  isSearching: false,
  setIsSearching: (v) => set({ isSearching: v }),

  selectedEmail: null,
  selectedEmailBody: null,
  isLoadingBody: false,
  setSelectedEmail: (email) => set({ selectedEmail: email, selectedEmailBody: null }),
  setSelectedEmailBody: (body) => set({ selectedEmailBody: body }),
  setLoadingBody: (loading) => set({ isLoadingBody: loading }),

  isComposeOpen: false,
  composeData: null,
  composeNonce: 0,
  openCompose: (data) => {
    const accounts = get().accounts
    const currentAccountId = get().currentAccountId
    const defaultAccountId = currentAccountId || accounts[0]?.id || ''
    set({
      isComposeOpen: true,
      composeNonce: get().composeNonce + 1,
      composeData: {
        to: '', cc: '', bcc: '', subject: '', body: '',
        accountId: defaultAccountId,
        ...data
      }
    })
  },
  closeCompose: () => set({ isComposeOpen: false, composeData: null }),

  showAccountModal: false,
  setShowAccountModal: (show) => set({ showAccountModal: show }),

  notification: null,
  showNotification: (type, message, options) => {
    const timeoutMs = options?.timeoutMs ?? 4000
    set({ notification: { type, message, action: options?.action } })
    if (typeof window !== 'undefined') {
      const key = '__hermesNotificationTimer__'
      const prev = (window as unknown as Record<string, number | undefined>)[key]
      if (prev) window.clearTimeout(prev)
      if (timeoutMs > 0) {
        const next = window.setTimeout(() => set({ notification: null }), timeoutMs)
        ;(window as unknown as Record<string, number | undefined>)[key] = next
      }
    }
  },
  clearNotification: () => {
    if (typeof window !== 'undefined') {
      const key = '__hermesNotificationTimer__'
      const prev = (window as unknown as Record<string, number | undefined>)[key]
      if (prev) {
        window.clearTimeout(prev)
        ;(window as unknown as Record<string, number | undefined>)[key] = undefined
      }
    }
    set({ notification: null })
  },

  // AI
  aiProvider: null,
  aiConfigured: false,
  setAiConfig: (provider, configured) => set({ aiProvider: provider, aiConfigured: configured }),

  // Categorization
  emailCategories: {},
  activeCategory: 'All',
  setEmailCategories: (categories) => set((s) => ({ emailCategories: { ...s.emailCategories, ...categories } })),
  setActiveCategory: (category) => set({ activeCategory: category }),

  // Multi-select
  selectedEmailIds: [],
  toggleEmailSelection: (id) => set((s) => ({
    selectedEmailIds: s.selectedEmailIds.includes(id)
      ? s.selectedEmailIds.filter(i => i !== id)
      : [...s.selectedEmailIds, id]
  })),
  clearEmailSelection: () => set({ selectedEmailIds: [] }),

  // Daily report
  pendingReport: null,
  setPendingReport: (report) => set({ pendingReport: report }),
  clearPendingReport: () => set({ pendingReport: null }),

  // Signature — persisted in localStorage (global + per-account).
  // Stored as a raw string, not JSON, so existing signatures keep working.
  signature: (() => { try { return localStorage.getItem('hermes-signature') || '' } catch { return '' } })(),
  setSignature: (sig) => {
    try { localStorage.setItem('hermes-signature', sig) } catch { /* quota or private mode */ }
    set({ signature: sig })
  },
  accountSignatures: readJson<Record<string, string>>('hermes-account-signatures', {}),
  setAccountSignature: (accountId, sig) => set((s) => {
    const next = { ...s.accountSignatures, [accountId]: sig }
    writeJson('hermes-account-signatures', next)
    return { accountSignatures: next }
  }),
  getSignatureFor: (accountId, aliasEmail) => {
    const s = get()
    if (aliasEmail) {
      const scoped = s.accountSignatures[`${accountId}:${aliasEmail.toLowerCase()}`]
      if (scoped !== undefined && scoped !== '') return scoped
    }
    return s.accountSignatures[accountId] || s.signature
  },
  setAliasSignature: (accountId, aliasEmail, sig) => set((s) => {
    const next = { ...s.accountSignatures, [`${accountId}:${aliasEmail.toLowerCase()}`]: sig }
    writeJson('hermes-account-signatures', next)
    return { accountSignatures: next }
  }),
  getSignatureForAccount: (accountId) => {
    const s = get()
    return s.accountSignatures[accountId] || s.signature
  },

  // Contacts autocomplete — persisted in localStorage
  contacts: readJson<string[]>('hermes-contacts', []),
  addContacts: (addresses) => set((s) => {
    const normalized = addresses
      .map(a => a.trim())
      .filter(Boolean)

    if (!normalized.length) return {}

    const byKey = new Map(s.contacts.map(c => [c.toLowerCase(), c]))
    const next: string[] = []
    const seen = new Set<string>()

    // Most recently used contacts should appear first.
    for (const raw of normalized) {
      const key = raw.toLowerCase()
      const canonical = byKey.get(key) || raw
      if (seen.has(key)) continue
      next.push(canonical)
      seen.add(key)
    }

    for (const c of s.contacts) {
      const key = c.toLowerCase()
      if (seen.has(key)) continue
      next.push(c)
      seen.add(key)
    }

    const merged = next.slice(0, 200)
    writeJson('hermes-contacts', merged)
    return { contacts: merged }
  }),

  // Snooze
  snoozes: [],
  setSnoozes: (snoozes) => set({ snoozes }),
  snoozeEmailLocal: (email, until) => set((s) => ({
    snoozes: [
      ...s.snoozes.filter(sn => sn.emailId !== email.id),
      { emailId: email.id, accountId: email.accountId, folder: email.folder, email, until, createdAt: new Date().toISOString() },
    ],
    // Hide it from the current list immediately
    emails: s.emails.filter(e => e.id !== email.id),
    selectedEmail: s.selectedEmail?.id === email.id ? null : s.selectedEmail,
    selectedEmailBody: s.selectedEmail?.id === email.id ? null : s.selectedEmailBody,
  })),
  unsnoozeLocal: (emailId) => set((s) => ({
    snoozes: s.snoozes.filter(sn => sn.emailId !== emailId),
  })),

  // Drafts — persisted in localStorage. Drafts carry base64 attachments, so a
  // save can exceed the origin quota; the oldest drafts are shed rather than
  // letting the write throw out of the setter and take the UI with it.
  drafts: readJson<Draft[]>('hermes-drafts', []),
  saveDraft: (draft) => set((s) => {
    const next = [draft, ...s.drafts.filter(d => d.id !== draft.id)]
    const { stored, dropped } = writeListWithinQuota('hermes-drafts', next)
    if (dropped > 0) {
      // The draft being saved is first in the list, so it is never the one shed.
      console.warn(`[drafts] Local storage full — dropped ${dropped} older draft(s).`)
    }
    return { drafts: stored }
  }),
  deleteDraft: (id) => set((s) => {
    const next = s.drafts.filter(d => d.id !== id)
    writeJson('hermes-drafts', next)
    return { drafts: next }
  }),
  showDraftsModal: false,
  setShowDraftsModal: (show) => set({ showDraftsModal: show }),

  showRulesModal: false,
  setShowRulesModal: (show) => set({ showRulesModal: show }),

  // AI Chat
  isChatOpen: false,
  toggleChat: () => set((s) => ({ isChatOpen: !s.isChatOpen })),

  pendingSend: null,
  setPendingSend: (send) => set({ pendingSend: send }),
  clearPendingSend: () => set({ pendingSend: null }),

  // Privacy — opt-in. Hermes blocks remote images in the reader for exactly
  // this reason; asking Gravatar for an avatar would otherwise tell a third
  // party who is in the user's inbox, one request per sender.
  gravatarEnabled: (() => {
    try { return localStorage.getItem('hermes-gravatar') === 'true' } catch { return false }
  })(),
  setGravatarEnabled: (enabled) => {
    try { localStorage.setItem('hermes-gravatar', String(enabled)) } catch { /* ignore */ }
    set({ gravatarEnabled: enabled })
  },

  // Theme — persisted in localStorage, defaults to following the OS.
  themePreference: readThemePreference(),
  theme: resolveTheme(readThemePreference()),
  setThemePreference: (preference) => {
    try {
      // 'system' is the absence of a choice, so it is stored as the absence of
      // a key. index.html reads the same key before the first paint.
      if (preference === 'system') localStorage.removeItem('hermes-theme')
      else localStorage.setItem('hermes-theme', preference)
    } catch { /* ignore */ }
    set({ themePreference: preference, theme: resolveTheme(preference) })
  },
  // The button cycles rather than flips, so 'system' is reachable without
  // opening settings: system -> light -> dark -> system.
  toggleTheme: () => {
    const order: ThemePreference[] = ['system', 'light', 'dark']
    const current = get().themePreference
    const next = order[(order.indexOf(current) + 1) % order.length]
    get().setThemePreference(next)
  },
  syncSystemTheme: (systemTheme) => {
    if (get().themePreference !== 'system') return
    set({ theme: systemTheme })
  },

  threadView: (() => {
    try {
      const raw = localStorage.getItem('hermes-thread-view')
      return raw ? raw === 'true' : true
    } catch { return true }
  })(),
  toggleThreadView: () => set((s) => {
    const next = !s.threadView
    try { localStorage.setItem('hermes-thread-view', String(next)) } catch { /* ignore */ }
    return { threadView: next }
  }),
}))
