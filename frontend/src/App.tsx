import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { EmailList } from './components/EmailList'
import { EmailViewer } from './components/EmailViewer'
import { ComposeModal } from './components/ComposeModal'
import { AccountModal } from './components/AccountModal'
import { HermesLogo } from './components/HermesLogo'
import { useEmailStore } from './store/emailStore'
import { accountsApi } from './api/client'

function Notification() {
  const { notification, clearNotification } = useEmailStore()
  if (!notification) return null

  return (
    <div
      className={`fixed top-4 right-4 z-[100] flex items-center gap-3 px-4 py-3 rounded-lg shadow-xl text-sm font-medium border
        ${notification.type === 'success'
          ? 'bg-[#dafbe1] dark:bg-[#1a2d1a] border-[#2da44e] dark:border-[#3fb950] text-[#116329] dark:text-[#3fb950]'
          : 'bg-[#ffeef0] dark:bg-[#2d1a1a] border-[#cf222e] dark:border-[#f85149] text-[#cf222e] dark:text-[#f85149]'
        }`}
    >
      <span>{notification.type === 'success' ? '✓' : '✕'}</span>
      <span className="text-[#1f2328] dark:text-[#e6edf3]">{notification.message}</span>
      <button onClick={clearNotification} className="opacity-50 hover:opacity-100 ml-2 text-[#1f2328] dark:text-[#e6edf3]">×</button>
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

function TopBar() {
  const { accounts, openCompose, setShowAccountModal, theme, toggleTheme } = useEmailStore()

  return (
    <header className="h-11 bg-[#f6f8fa] dark:bg-[#161b22] border-b border-[#d0d7de] dark:border-[#30363d] flex items-center px-4 gap-4 flex-shrink-0">
      <div className="flex items-center gap-2.5">
        <HermesLogo size={28} />
        <span className="text-[#1f2328] dark:text-[#e6edf3] font-semibold text-base tracking-wide">Hermes</span>
      </div>

      <div className="flex-1" />

      {accounts.length > 0 && (
        <button
          onClick={() => openCompose()}
          className="flex items-center gap-1.5 bg-[#f59e0b] text-[#0d1117] text-xs font-bold px-3 py-1.5 rounded-md hover:bg-[#fbbf24] transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Compose
        </button>
      )}

      {/* Light / dark toggle */}
      <button
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] p-1.5 rounded hover:bg-[#eaeef2] dark:hover:bg-[#21262d] transition-colors"
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>

      <button
        onClick={() => setShowAccountModal(true)}
        title="Manage accounts"
        className="text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] p-1.5 rounded hover:bg-[#eaeef2] dark:hover:bg-[#21262d] transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>
    </header>
  )
}

export default function App() {
  const { isComposeOpen, showAccountModal, setAccounts, setCurrentAccount, showNotification, theme } = useEmailStore()

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
    // Applying `dark` class here activates all dark: Tailwind variants in every child
    <div className={`flex flex-col h-screen overflow-hidden transition-colors duration-200 bg-white dark:bg-[#0d1117] ${theme === 'dark' ? 'dark' : ''}`}>
      <TopBar />

      <div className="flex flex-1 min-h-0">
        <Sidebar />

        <div className="w-72 flex-shrink-0 border-r border-[#d0d7de] dark:border-[#30363d] flex flex-col overflow-hidden">
          <EmailList />
        </div>

        <div className="flex-1 min-w-0 overflow-hidden">
          <EmailViewer />
        </div>
      </div>

      {isComposeOpen && <ComposeModal />}
      {showAccountModal && <AccountModal />}
      <Notification />
    </div>
  )
}
