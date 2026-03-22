import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, Component, type ReactNode } from 'react'
import { Sidebar } from './components/Sidebar'
import { EmailList } from './components/EmailList'
import { EmailViewer } from './components/EmailViewer'
import { AiChatPanel } from './components/AiChatPanel'
import { HermesLogo } from './components/HermesLogo'
import { useEmailStore } from './store/emailStore'
import { accountsApi, aiApi, emailsApi } from './api/client'

const ComposeModal = lazy(() => import('./components/ComposeModal').then(m => ({ default: m.ComposeModal })))
const AccountModal = lazy(() => import('./components/AccountModal').then(m => ({ default: m.AccountModal })))
const DailyReportModal = lazy(() => import('./components/DailyReportModal').then(m => ({ default: m.DailyReportModal })))

function Notification() {
  const { notification, clearNotification } = useEmailStore()
  if (!notification) return null

  return (
    <div
      className={`fixed top-4 right-4 z-[100] flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl text-sm font-medium border notification-slide-in
        ${notification.type === 'success'
          ? 'bg-white dark:bg-[#1c2128] border-[#2da44e] dark:border-[#3fb950] shadow-green-100 dark:shadow-none'
          : 'bg-white dark:bg-[#1c2128] border-[#cf222e] dark:border-[#f85149] shadow-red-100 dark:shadow-none'
        }`}
    >
      <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold
        ${notification.type === 'success' ? 'bg-[#dafbe1] dark:bg-[#238636]/30 text-[#116329] dark:text-[#3fb950]' : 'bg-[#ffeef0] dark:bg-[#f85149]/20 text-[#cf222e] dark:text-[#f85149]'}`}>
        {notification.type === 'success' ? '✓' : '✕'}
      </div>
      <span className="text-[#1f2328] dark:text-[#e6edf3]">{notification.message}</span>
      {notification.action && (
        <button
          onClick={() => {
            notification.action?.onClick()
            clearNotification()
          }}
          className="px-2 py-1 rounded-md text-xs font-semibold bg-[#f59e0b] text-[#0d1117] hover:bg-[#fbbf24] transition-colors"
        >
          {notification.action.label}
        </button>
      )}
      <button onClick={clearNotification} aria-label="Dismiss notification" className="text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] ml-1 transition-colors">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
      </button>
    </div>
  )
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M13.5 10.5A6 6 0 016 2.5a6 6 0 100 11 6 6 0 007.5-3z"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M3.4 12.6l.85-.85M11.75 4.25l.85-.85" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M6.3 1.9a6.5 6.5 0 000 0M8 1C4.13 1 1 4.13 1 8s3.13 7 7 7 7-3.13 7-7" stroke="none"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM4 8a4 4 0 118 0A4 4 0 014 8z" fill="none"/>
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
      <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M17.66 10a7.95 7.95 0 01-.09 1.09l2.12 1.65a.5.5 0 01.12.64l-2 3.46a.5.5 0 01-.61.22l-2.49-1a8.2 8.2 0 01-1.88 1.09l-.38 2.65a.49.49 0 01-.49.42h-4a.49.49 0 01-.49-.42l-.38-2.65a8.2 8.2 0 01-1.88-1.09l-2.49 1a.5.5 0 01-.61-.22l-2-3.46a.49.49 0 01.12-.64l2.12-1.65a8.06 8.06 0 010-2.18L.43 6.17a.5.5 0 01-.12-.64l2-3.46a.5.5 0 01.61-.22l2.49 1a8.2 8.2 0 011.88-1.09L7.67.59A.49.49 0 018.16.17h4a.49.49 0 01.49.42l.38 2.65a8.2 8.2 0 011.88 1.09l2.49-1a.5.5 0 01.61.22l2 3.46a.49.49 0 01-.12.64l-2.12 1.65c.06.36.09.73.09 1.1z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function TopBar() {
  const { theme, toggleTheme, setShowAccountModal, isChatOpen, toggleChat, aiConfigured } = useEmailStore()

  return (
    <header className="h-11 bg-[#f6f8fa] dark:bg-[#161b22] border-b border-[#d0d7de] dark:border-[#30363d] flex items-center px-4 gap-3 flex-shrink-0">
      <div className="flex items-center gap-2.5">
        <HermesLogo size={28} />
        <span className="text-[#1f2328] dark:text-[#e6edf3] font-bold text-[15px] tracking-tight">Hermes</span>
      </div>

      <div className="flex-1" />

      <button
        onClick={toggleChat}
        title="AI Assistant"
        aria-label={isChatOpen ? 'Close AI Assistant' : 'Open AI Assistant'}
        className={`p-1.5 rounded-md transition-colors ${isChatOpen
          ? 'text-[#7c3aed] bg-[#f3f0ff] dark:bg-[#7c3aed]/20'
          : 'text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d]'
        } ${!aiConfigured ? 'opacity-50' : ''}`}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1.4"/>
          <path d="M5.5 6.5C5.5 5.12 6.62 4 8 4s2.5 1.12 2.5 2.5c0 1.5-1.5 2-2 2.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          <circle cx="8" cy="11.5" r=".75" fill="currentColor"/>
        </svg>
      </button>

      <button
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] p-1.5 rounded-md hover:bg-[#eaeef2] dark:hover:bg-[#21262d] transition-colors"
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>

      <button
        onClick={() => setShowAccountModal(true)}
        title="Settings"
        aria-label="Open settings"
        className="text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] p-1.5 rounded-md hover:bg-[#eaeef2] dark:hover:bg-[#21262d] transition-colors"
      >
        <SettingsIcon />
      </button>

      <button
        onClick={() => window.dispatchEvent(new CustomEvent('hermes:toggle-shortcuts'))}
        title="Keyboard shortcuts (?)"
        aria-label="Show keyboard shortcuts"
        className="text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] p-1.5 rounded-md hover:bg-[#eaeef2] dark:hover:bg-[#21262d] transition-colors"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="4" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M4 7h1M7 7h2M11 7h1M4 10h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      </button>
    </header>
  )
}

// ─── Error Boundary ──────────────────────────────────────────────────────────
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-white dark:bg-[#0d1117] text-center p-8">
          <div className="w-16 h-16 rounded-2xl bg-[#fff0ee] dark:bg-[#f85149]/10 flex items-center justify-center mb-4">
            <svg width="32" height="32" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="#cf222e" strokeWidth="1.5"/>
              <path d="M8 5v4M8 11v.5" stroke="#cf222e" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-[#1f2328] dark:text-[#e6edf3] mb-2">Something went wrong</h2>
          <p className="text-sm text-[#656d76] dark:text-[#8b949e] mb-4 max-w-md">{this.state.error?.message}</p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
            className="px-4 py-2 text-sm font-medium bg-[#f59e0b] text-[#0d1117] rounded-lg hover:bg-[#fbbf24] transition-colors"
          >
            Reload Hermes
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Keyboard Shortcuts Help ─────────────────────────────────────────────────
function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    { key: 'Ctrl+N', desc: 'New message' },
    { key: '/', desc: 'Search' },
    { key: 'r', desc: 'Reply' },
    { key: 'f', desc: 'Forward' },
    { key: 's', desc: 'Star / unstar' },
    { key: 'e', desc: 'Archive' },
    { key: 'u', desc: 'Mark unread' },
    { key: 'd', desc: 'Delete' },
    { key: 'Esc', desc: 'Deselect / close' },
    { key: '?', desc: 'Show shortcuts' },
  ]
  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-white dark:bg-[#161b22] rounded-xl border border-[#d0d7de] dark:border-[#30363d] shadow-2xl w-[340px] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#d0d7de] dark:border-[#30363d]">
          <h2 className="font-semibold text-sm text-[#1f2328] dark:text-[#e6edf3]">Keyboard Shortcuts</h2>
          <button onClick={onClose} className="text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] p-1 rounded transition-colors">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>
        <div className="px-5 py-3">
          {shortcuts.map(s => (
            <div key={s.key} className="flex items-center justify-between py-1.5">
              <span className="text-xs text-[#656d76] dark:text-[#8b949e]">{s.desc}</span>
              <kbd className="px-2 py-0.5 text-[10px] font-mono bg-[#f6f8fa] dark:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] rounded text-[#1f2328] dark:text-[#e6edf3]">{s.key}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────
function useKeyboardShortcuts() {
  const { openCompose, selectedEmail, isComposeOpen, showAccountModal, isChatOpen } = useEmailStore()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      // Global shortcuts (work even in inputs)
      if (e.key === 'Escape') {
        if (isComposeOpen || showAccountModal || isChatOpen) return // handled by their own close logic
        useEmailStore.getState().setSelectedEmail(null)
        useEmailStore.getState().setSelectedEmailBody(null)
        useEmailStore.getState().clearEmailSelection()
        return
      }

      // Skip shortcuts when typing in inputs
      if (isInput) return

      // Ctrl/Cmd+N — Compose
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault()
        openCompose()
        return
      }

      // / — Focus search
      if (e.key === '/') {
        e.preventDefault()
        const searchBtn = document.querySelector('[title="Search"]') as HTMLButtonElement
        searchBtn?.click()
        return
      }

      // r — Reply (when email selected)
      if (e.key === 'r' && selectedEmail && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        const replyBtn = document.querySelector('[aria-label="Reply to email"]') as HTMLButtonElement
        replyBtn?.click()
        return
      }

      // f — Forward
      if (e.key === 'f' && selectedEmail && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        const fwdBtn = document.querySelector('[aria-label="Forward email"]') as HTMLButtonElement
        fwdBtn?.click()
        return
      }

      // d or Delete — Delete
      if ((e.key === 'd' || e.key === 'Delete') && selectedEmail && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        const delBtn = document.querySelector('[aria-label="Delete email"]') as HTMLButtonElement
        delBtn?.click()
        return
      }

      // u — Mark unread
      if (e.key === 'u' && selectedEmail && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        const btn = document.querySelector('[aria-label="Mark as unread"]') as HTMLButtonElement
        btn?.click()
        return
      }

      // s — Star/unstar
      if (e.key === 's' && selectedEmail && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        useEmailStore.getState().toggleStarLocal(selectedEmail.id)
        emailsApi.star(selectedEmail.accountId, selectedEmail.id, !selectedEmail.starred, selectedEmail.folder).catch(() => {
          useEmailStore.getState().toggleStarLocal(selectedEmail.id)
        })
        return
      }

      // e — Archive (move to Archive)
      if (e.key === 'e' && selectedEmail && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        emailsApi.move(selectedEmail.accountId, selectedEmail.id, 'Archive', selectedEmail.folder).then(() => {
          useEmailStore.getState().removeEmail(selectedEmail.id)
          useEmailStore.getState().showNotification('success', 'Archived')
        }).catch(() => {
          useEmailStore.getState().showNotification('error', 'Failed to archive')
        })
        return
      }

      // ? — Show keyboard shortcuts
      if (e.key === '?') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('hermes:toggle-shortcuts'))
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openCompose, selectedEmail, isComposeOpen, showAccountModal, isChatOpen])
}

export default function App() {
  const { isComposeOpen, showAccountModal, setAccounts, setCurrentAccount, showNotification, theme, setAiConfig, setPendingReport, isChatOpen } = useEmailStore()
  useKeyboardShortcuts()
  const [showShortcuts, setShowShortcuts] = useState(false)
  const appLayoutVars = { '--sidebar-width': '13rem' } as CSSProperties

  useEffect(() => {
    const handler = () => setShowShortcuts(v => !v)
    window.addEventListener('hermes:toggle-shortcuts', handler)
    return () => window.removeEventListener('hermes:toggle-shortcuts', handler)
  }, [])
  const splitRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ type: 'list' | 'chat'; startX: number; startWidth: number } | null>(null)
  const [listPaneWidth, setListPaneWidth] = useState(380)
  const [chatPaneWidth, setChatPaneWidth] = useState(288)

  const onDragMove = useCallback((e: MouseEvent) => {
    if (!dragRef.current) return

    if (dragRef.current.type === 'list') {
      const total = splitRef.current?.clientWidth || 0
      const minList = 280
      const minViewer = 360
      const maxList = Math.max(minList, total - minViewer)
      const next = Math.max(minList, Math.min(maxList, dragRef.current.startWidth + (e.clientX - dragRef.current.startX)))
      setListPaneWidth(next)
      return
    }

    const minChat = 220
    const maxChat = 520
    const next = Math.max(minChat, Math.min(maxChat, dragRef.current.startWidth + (dragRef.current.startX - e.clientX)))
    setChatPaneWidth(next)
  }, [])

  const onDragEnd = useCallback(() => {
    dragRef.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragEnd)
  }, [onDragMove])

  const startDrag = (type: 'list' | 'chat', startWidth: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { type, startX: e.clientX, startWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onDragMove)
    window.addEventListener('mouseup', onDragEnd)
  }

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', onDragMove)
      window.removeEventListener('mouseup', onDragEnd)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [onDragEnd, onDragMove])

  useEffect(() => {
    aiApi.getSettings().then(({ provider, configured }) => {
      if (provider) setAiConfig(provider, configured)
    }).catch(() => {})

    // Poll until a report arrives (backend generates it async on startup)
    const checkReport = () => {
      emailsApi.getDailyReport().then(report => {
        if (report) setPendingReport(report)
      }).catch(() => {})
    }
    checkReport()
    const reportPoll = setInterval(checkReport, 30_000)
    return () => clearInterval(reportPoll)
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const authType = params.get('auth')
    const success  = params.get('success')
    const error    = params.get('error')

    if (success && authType) {
      showNotification('success', `${authType === 'gmail' ? 'Gmail' : 'Outlook'} account connected!`)
      window.history.replaceState({}, '', '/')
      accountsApi.list().then(accounts => {
        setAccounts(accounts)
        if (accounts.length > 0) setCurrentAccount(accounts[0].id)
      })
    } else if (error) {
      showNotification('error', decodeURIComponent(error))
      window.history.replaceState({}, '', '/')
    }
  }, [])

  return (
    <ErrorBoundary>
      <div
        style={appLayoutVars}
        className={`flex flex-col h-screen overflow-hidden transition-colors duration-200 bg-white dark:bg-[#0d1117] ${theme === 'dark' ? 'dark' : ''}`}
      >
        <TopBar />

        <div className="flex flex-1 min-h-0">
          <Sidebar />

          <div ref={splitRef} className="flex flex-1 min-w-0">
            <div style={{ width: `${listPaneWidth}px` }} className="min-w-0 border-r border-[#d0d7de] dark:border-[#30363d] flex flex-col overflow-hidden flex-shrink-0">
              <EmailList />
            </div>

            <div
              onMouseDown={startDrag('list', listPaneWidth)}
              className="w-1 flex-shrink-0 cursor-col-resize bg-transparent hover:bg-[#d0d7de] dark:hover:bg-[#30363d] transition-colors"
              title="Resize inbox and email content"
            />

            <div id="email-content-host" className="relative flex-1 min-w-0 overflow-hidden">
              <EmailViewer />
            </div>
          </div>

          {isChatOpen && (
            <div
              onMouseDown={startDrag('chat', chatPaneWidth)}
              className="w-1 flex-shrink-0 cursor-col-resize bg-transparent hover:bg-[#d0d7de] dark:hover:bg-[#30363d] transition-colors"
              title="Resize AI assistant"
            />
          )}

          {isChatOpen && (
            <div style={{ width: `${chatPaneWidth}px` }} className="flex-shrink-0 overflow-hidden">
              <AiChatPanel />
            </div>
          )}
        </div>

        <Suspense fallback={null}>
          {isComposeOpen && <ComposeModal />}
          {showAccountModal && <AccountModal />}
          <DailyReportModal />
        </Suspense>
        <Notification />
        {showShortcuts && <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />}
      </div>
    </ErrorBoundary>
  )
}

