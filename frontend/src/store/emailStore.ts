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
  setLoadingEmails: (loading: boolean) => void
  markEmailRead: (id: string) => void
  removeEmail: (id: string) => void

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
  setCurrentAccount: (id) => set({ currentAccountId: id, selectedEmail: null, selectedEmailBody: null }),
  setCurrentFolder: (folder) => set({ currentFolder: folder, selectedEmail: null, selectedEmailBody: null }),

  folders: {},
  setFolders: (accountId, folders) => set((s) => ({ folders: { ...s.folders, [accountId]: folders } })),

  emails: [],
  isLoadingEmails: false,
  setEmails: (emails) => set({ emails }),
  setLoadingEmails: (loading) => set({ isLoadingEmails: loading }),
  markEmailRead: (id) => set((s) => ({
    emails: s.emails.map(e => e.id === id ? { ...e, read: true } : e)
  })),
  removeEmail: (id) => set((s) => ({
    emails: s.emails.filter(e => e.id !== id),
    selectedEmail: s.selectedEmail?.id === id ? null : s.selectedEmail,
    selectedEmailBody: s.selectedEmail?.id === id ? null : s.selectedEmailBody,
  })),

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

  // Daily report
  pendingReport: null,
  setPendingReport: (report) => set({ pendingReport: report }),
  clearPendingReport: () => set({ pendingReport: null }),

  // Theme — persisted in localStorage, defaults to dark
  theme: (localStorage.getItem('hermes-theme') as 'dark' | 'light') || 'dark',
  toggleTheme: () => set((s) => {
    const next = s.theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem('hermes-theme', next)
    return { theme: next }
  }),
}))
