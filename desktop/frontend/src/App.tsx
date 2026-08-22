import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, Component, type ReactNode } from 'react'
import { Sidebar } from './components/Sidebar'
import { EmailList } from './components/EmailList'
import { EmailViewer } from './components/EmailViewer'
import { AiChatPanel } from './components/AiChatPanel'
import { HermesLogo } from './components/HermesLogo'
import { UndoSendBar } from './components/UndoSendBar'
import { useEmailStore } from './store/emailStore'
import { accountsApi, aiApi, emailsApi } from './api/client'

const ComposeModal = lazy(() => import('./components/ComposeModal').then(m => ({ default: m.ComposeModal })))
const AccountModal = lazy(() => import('./components/AccountModal').then(m => ({ default: m.AccountModal })))
const DailyReportModal = lazy(() => import('./components/DailyReportModal').then(m => ({ default: m.DailyReportModal })))
const DraftsModal = lazy(() => import('./components/DraftsModal').then(m => ({ default: m.DraftsModal })))
const OutboxModal = lazy(() => import('./components/OutboxModal').then(m => ({ default: m.OutboxModal })))
const RulesModal = lazy(() => import('./components/RulesModal').then(m => ({ default: m.RulesModal })))

// Bridge exposed by the Electron preload script. Absent when running in a
// plain browser, so every use is optional.
declare global {
  interface Window {
    hermes?: {
      isDesktop: boolean
      on: (channel: string, handler: (payload: unknown) => void) => () => void
    }
  }
}

function Notification() {
  const { notification, clearNotification } = useEmailStore()
  if (!notification) return null

  const success = notification.type === 'success'

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 pl-3 pr-2.5 py-2.5
                 rounded-2xl glass-elevated shadow-pop text-[13px] font-medium notification-slide-in max-w-[min(90vw,26rem)]"
    >
      <div
        className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold text-white
          ${success ? 'bg-success' : 'bg-danger'}`}
      >
        {success ? '✓' : '✕'}
      </div>
      <span className="text-ink flex-1 min-w-0 truncate">{notification.message}</span>
      {notification.action && (
        <button
          onClick={() => {
            notification.action?.onClick()
            clearNotification()
          }}
          className="btn-accent px-2.5 py-1 rounded-lg text-xs font-semibold flex-shrink-0"
        >
          {notification.action.label}
        </button>
      )}
      <button
        onClick={clearNotification}
        aria-label="Dismiss notification"
        className="btn-ghost p-1.5 flex-shrink-0"
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
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

  const chip = 'w-8 h-8 rounded-[10px] flex items-center justify-center btn-ghost'

  return (
    <header className="h-12 glass-chrome flex items-center px-3 gap-1.5 flex-shrink-0 relative z-20 border-b border-line/40">
      <div className="flex items-center gap-2 pl-1 pr-2">
        <HermesLogo size={26} />
        <span className="text-ink font-semibold text-[14.5px] tracking-[-0.01em]">Hermes</span>
      </div>

      <div className="flex-1" />

      <button
        onClick={toggleChat}
        title="AI Assistant"
        aria-label={isChatOpen ? 'Close AI Assistant' : 'Open AI Assistant'}
        className={`${chip} ${isChatOpen ? '!text-ai !bg-ai/12' : ''} ${!aiConfigured ? 'opacity-50' : ''}`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1.4"/>
          <path d="M5.5 6.5C5.5 5.12 6.62 4 8 4s2.5 1.12 2.5 2.5c0 1.5-1.5 2-2 2.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          <circle cx="8" cy="11.5" r=".75" fill="currentColor"/>
        </svg>
      </button>

      <button
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className={chip}
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>

      <button
        onClick={() => setShowAccountModal(true)}
        title="Settings"
        aria-label="Open settings"
        className={chip}
      >
        <SettingsIcon />
      </button>

      <button
        onClick={() => window.dispatchEvent(new CustomEvent('hermes:toggle-shortcuts'))}
        title="Keyboard shortcuts (?)"
        aria-label="Show keyboard shortcuts"
        className={chip}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="4" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M4 7h1M7 7h2M11 7h1M4 10h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      </button>
    </header>
  )
}

// A wide, invisible grab strip with a thin visible pill. The hit area has to
// be larger than the line you can see, or the drag is fiddly.
function Handle({ onMouseDown, title }: { onMouseDown: (e: React.MouseEvent) => void; title: string }) {
  return (
    <div
      onMouseDown={onMouseDown}
      title={title}
      role="separator"
      aria-orientation="vertical"
      className="group relative w-1.5 flex-shrink-0 cursor-col-resize flex items-center justify-center"
    >
      <div className="w-[3px] h-10 rounded-full bg-ink-3/0 group-hover:bg-ink-3/40 transition-colors duration-200" />
    </div>
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
        <div className="flex flex-col items-center justify-center h-screen bg-bg text-center p-8">
          <div className="w-16 h-16 rounded-2xl bg-danger/10 flex items-center justify-center mb-5 text-danger">
            <svg width="30" height="30" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M8 5v4M8 11v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <h2 className="text-[17px] font-semibold text-ink mb-2 tracking-[-0.01em]">Something went wrong</h2>
          <p className="text-[13px] text-ink-2 mb-6 max-w-md leading-relaxed">{this.state.error?.message}</p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
            className="btn-accent px-5 py-2.5 text-[13px] font-semibold rounded-xl"
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
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[100] flex items-center justify-center animate-fade" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="glass-elevated rounded-3xl w-[360px] overflow-hidden animate-rise"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <h2 className="font-semibold text-[15px] text-ink tracking-[-0.01em]">Keyboard shortcuts</h2>
          <button onClick={onClose} aria-label="Close" className="btn-ghost p-1.5">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
          </button>
        </div>
        <div className="px-3 pb-3">
          {shortcuts.map(s => (
            <div key={s.key} className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-ink/5 transition-colors">
              <span className="text-[13px] text-ink-2">{s.desc}</span>
              <kbd className="px-2 py-0.5 text-[11px] font-medium bg-ink/6 border border-line/50 rounded-md text-ink tabular-nums">{s.key}</kbd>
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

      // e — Archive (move to the account's resolved archive folder)
      if (e.key === 'e' && selectedEmail && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        const archiveFolder = useEmailStore.getState().getArchiveFolder(selectedEmail.accountId)
        emailsApi.move(selectedEmail.accountId, selectedEmail.id, archiveFolder, selectedEmail.folder).then(() => {
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
  const {
    isComposeOpen, composeNonce, showAccountModal, showDraftsModal, showOutboxModal, showRulesModal,
    setAccounts, setCurrentAccount, showNotification, theme, setAiConfig, setPendingReport,
    setSnoozes, isChatOpen,
  } = useEmailStore()
  useKeyboardShortcuts()
  const [showShortcuts, setShowShortcuts] = useState(false)
  const appLayoutVars = { '--sidebar-width': '14rem' } as CSSProperties

  // The theme lives on <html>, not on a wrapper div: `body`, the page's own
  // scrollbars, and native form controls (via color-scheme) all sit outside
  // any element the React tree can put a class on.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

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

    // Keep the snoozed set in sync (the backend wakes due snoozes on a timer)
    const refreshSnoozes = () => {
      emailsApi.listSnoozed().then(setSnoozes).catch(() => {})
    }
    refreshSnoozes()
    const snoozePoll = setInterval(refreshSnoozes, 30_000)

    return () => { clearInterval(reportPoll); clearInterval(snoozePoll) }
  }, [])

  // Desktop shell events: a clicked notification should open that exact
  // message, and the tray's Compose entry should open the composer.
  useEffect(() => {
    const bridge = window.hermes
    if (!bridge) return

    const unsubscribeOpen = bridge.on('hermes:open', async (payload) => {
      const target = payload as { accountId?: string; emailId?: string; folder?: string; view?: string } | undefined
      if (!target) return
      if (target.view === 'outbox') { useEmailStore.getState().setShowOutboxModal(true); return }
      if (!target.accountId) return

      const store = useEmailStore.getState()
      store.setCurrentAccount(target.accountId)
      store.setCurrentFolder(target.folder || 'INBOX')

      try {
        const { emails } = await emailsApi.list(target.accountId, target.folder || 'INBOX')
        store.setEmails(emails)
        const match = target.emailId ? emails.find(e => e.id === target.emailId) : undefined
        if (match) {
          store.setSelectedEmail(match)
          store.setLoadingBody(true)
          try {
            store.setSelectedEmailBody(await emailsApi.getBody(match.accountId, match.id, match.folder))
          } finally {
            store.setLoadingBody(false)
          }
        }
      } catch {
        showNotification('error', 'Could not open that message')
      }
    })

    const unsubscribeCompose = bridge.on('hermes:compose', () => useEmailStore.getState().openCompose())
    const unsubscribeDown = bridge.on('hermes:backend-down', () =>
      showNotification('error', 'The Hermes background service stopped. Restart the app to reconnect.', { timeoutMs: 0 })
    )

    return () => { unsubscribeOpen(); unsubscribeCompose(); unsubscribeDown() }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const authType = params.get('auth')
    const success = params.get('success')
    const error = params.get('error')

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
        className="flex flex-col h-screen overflow-hidden relative z-10"
      >
        <TopBar />

        {/* The three panes float on the ambient wash as separate glass slabs,
            separated by gaps rather than borders. */}
        <div className="flex flex-1 min-h-0 gap-1.5 p-1.5 pt-0">
          <Sidebar />

          <div ref={splitRef} className="flex flex-1 min-w-0 gap-1.5">
            <div
              style={{ width: `${listPaneWidth}px` }}
              className="min-w-0 flex flex-col overflow-hidden flex-shrink-0 glass rounded-2xl shadow-pane rim-top"
            >
              <EmailList />
            </div>

            <Handle onMouseDown={startDrag('list', listPaneWidth)} title="Resize inbox and email content" />

            <div id="email-content-host" className="relative flex-1 min-w-0 overflow-hidden glass rounded-2xl shadow-pane rim-top">
              <EmailViewer />
            </div>
          </div>

          {isChatOpen && (
            <>
              <Handle onMouseDown={startDrag('chat', chatPaneWidth)} title="Resize AI assistant" />
              <div
                style={{ width: `${chatPaneWidth}px` }}
                className="flex-shrink-0 overflow-hidden glass rounded-2xl shadow-pane rim-top animate-rise"
              >
                <AiChatPanel />
              </div>
            </>
          )}
        </div>

        <Suspense fallback={null}>
          {isComposeOpen && <ComposeModal key={composeNonce} />}
          {showAccountModal && <AccountModal />}
          {showDraftsModal && <DraftsModal />}
          {showOutboxModal && <OutboxModal />}
          {showRulesModal && <RulesModal />}
          <DailyReportModal />
        </Suspense>
        <Notification />
        <UndoSendBar />
        {showShortcuts && <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />}
      </div>
    </ErrorBoundary>
  )
}

