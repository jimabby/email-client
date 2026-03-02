import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { EmailList } from './components/EmailList'
import { EmailViewer } from './components/EmailViewer'
import { ComposeModal } from './components/ComposeModal'
import { AccountModal } from './components/AccountModal'
import { HermesLogo } from './components/HermesLogo'
import { useEmailStore } from './store/emailStore'
import { accountsApi, aiApi, emailsApi } from './api/client'
import { DailyReportModal } from './components/DailyReportModal'

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
      <button onClick={clearNotification} className="text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] ml-1 transition-colors">
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
  const { theme, toggleTheme, setShowAccountModal } = useEmailStore()

  return (
    <header className="h-11 bg-[#f6f8fa] dark:bg-[#161b22] border-b border-[#d0d7de] dark:border-[#30363d] flex items-center px-4 gap-3 flex-shrink-0">
      <div className="flex items-center gap-2.5">
        <HermesLogo size={28} />
        <span className="text-[#1f2328] dark:text-[#e6edf3] font-bold text-[15px] tracking-tight">Hermes</span>
      </div>

      <div className="flex-1" />

      <button
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] p-1.5 rounded-md hover:bg-[#eaeef2] dark:hover:bg-[#21262d] transition-colors"
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>

      <button
        onClick={() => setShowAccountModal(true)}
        title="Settings"
        className="text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] p-1.5 rounded-md hover:bg-[#eaeef2] dark:hover:bg-[#21262d] transition-colors"
      >
        <SettingsIcon />
      </button>
    </header>
  )
}

export default function App() {
  const { isComposeOpen, showAccountModal, setAccounts, setCurrentAccount, showNotification, theme, setAiConfig, setPendingReport } = useEmailStore()

  useEffect(() => {
    aiApi.getSettings().then(({ provider, configured }) => {
      if (provider) setAiConfig(provider, configured)
    }).catch(() => {})

    emailsApi.getDailyReport().then(report => {
      if (report) setPendingReport(report)
    }).catch(() => {})
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
    <div className={`flex flex-col h-screen overflow-hidden transition-colors duration-200 bg-white dark:bg-[#0d1117] ${theme === 'dark' ? 'dark' : ''}`}>
      <TopBar />

      <div className="flex flex-1 min-h-0">
        <Sidebar />

        <div className="flex-[1] min-w-0 border-r border-[#d0d7de] dark:border-[#30363d] flex flex-col overflow-hidden">
          <EmailList />
        </div>

        <div className="flex-[2] min-w-0 overflow-hidden">
          <EmailViewer />
        </div>
      </div>

      {isComposeOpen && <ComposeModal />}
      {showAccountModal && <AccountModal />}
      <DailyReportModal />
      <Notification />
    </div>
  )
}
