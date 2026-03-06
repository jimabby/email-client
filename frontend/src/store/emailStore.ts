import { create } from 'zustand'
import type { Account, EmailSummary, EmailBody, Folder, ComposeData, EmailCategory } from '../types/email'

interface EmailStore {
  // Accounts
  accounts: Account[]
  setAccounts: (accounts: Account[]) => void
  addAccount: (account: Account) => void
  removeAccount: (id: string) => void

  // Navigation
  currentAccountId: string | null
  currentFolder: string
  setCurrentAccount: (id: string | null) => void
  setCurrentFolder: (folder: string) => void

  // Folders
  folders: Record<string, Folder[]>
  setFolders: (accountId: string, folders: Folder[]) => void

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
  openCompose: (data?: Partial<ComposeData>) => void
  closeCompose: () => void

  // UI
  showAccountModal: boolean
  setShowAccountModal: (show: boolean) => void
  notification: { type: 'success' | 'error'; message: string } | null
  showNotification: (type: 'success' | 'error', message: string) => void
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

  // Signature (localStorage-persisted)
  signature: string
  setSignature: (sig: string) => void

  // Contacts autocomplete (localStorage-persisted)
  contacts: string[]
  addContacts: (addresses: string[]) => void

  // Theme
  theme: 'dark' | 'light'
  toggleTheme: () => void
}

export const useEmailStore = create<EmailStore>((set, get) => ({
  accounts: [],
  setAccounts: (accounts) => set({ accounts }),
  addAccount: (account) => set((s) => ({ accounts: [...s.accounts, account] })),
  removeAccount: (id) => set((s) => ({ accounts: s.accounts.filter(a => a.id !== id) })),

  currentAccountId: null,
  currentFolder: 'INBOX',
  setCurrentAccount: (id) => set({ currentAccountId: id, selectedEmail: null, selectedEmailBody: null, nextToken: null, searchResults: null }),
  setCurrentFolder: (folder) => set({ currentFolder: folder, selectedEmail: null, selectedEmailBody: null, nextToken: null, searchResults: null }),

  folders: {},
  setFolders: (accountId, folders) => set((s) => ({ folders: { ...s.folders, [accountId]: folders } })),

  emails: [],
  isLoadingEmails: false,
  setEmails: (emails) => set({ emails }),
  appendEmails: (emails) => set((s) => ({ emails: [...s.emails, ...emails] })),
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
  openCompose: (data) => {
    const accounts = get().accounts
    const currentAccountId = get().currentAccountId
    const defaultAccountId = currentAccountId || accounts[0]?.id || ''
    set({
      isComposeOpen: true,
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
  showNotification: (type, message) => {
    set({ notification: { type, message } })
    setTimeout(() => set({ notification: null }), 4000)
  },
  clearNotification: () => set({ notification: null }),

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

  // Signature — persisted in localStorage
  signature: localStorage.getItem('hermes-signature') || '',
  setSignature: (sig) => {
    localStorage.setItem('hermes-signature', sig)
    set({ signature: sig })
  },

  // Contacts autocomplete — persisted in localStorage
  contacts: (() => {
    try { return JSON.parse(localStorage.getItem('hermes-contacts') || '[]') } catch { return [] }
  })(),
  addContacts: (addresses) => set((s) => {
    const existing = new Set(s.contacts)
    const fresh = addresses.filter(a => a && !existing.has(a))
    if (!fresh.length) return {}
    const merged = [...fresh, ...s.contacts].slice(0, 200)
    localStorage.setItem('hermes-contacts', JSON.stringify(merged))
    return { contacts: merged }
  }),

  // Theme — persisted in localStorage, defaults to dark
  theme: (localStorage.getItem('hermes-theme') as 'dark' | 'light') || 'dark',
  toggleTheme: () => set((s) => {
    const next = s.theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem('hermes-theme', next)
    return { theme: next }
  }),
}))
