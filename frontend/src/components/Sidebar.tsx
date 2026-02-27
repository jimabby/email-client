import { useEffect } from 'react'
import { useEmailStore } from '../store/emailStore'
import { accountsApi, emailsApi } from '../api/client'

const InboxIcon  = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 10h3l1.5 2h5L12 10h3V13a1 1 0 01-1 1H2a1 1 0 01-1-1v-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M1 10V4a1 1 0 011-1h12a1 1 0 011 1v6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
const SentIcon   = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13.5 2.5L7 9M13.5 2.5L9 14l-2-5-5-2 11.5-4.5z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
const DraftsIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6l-3-4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M10 2v4h4M6 9h4M6 11.5h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
const TrashIcon  = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6L12 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
const SpamIcon   = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/><path d="M8 5v4M8 11v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
const FolderIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 4a1 1 0 011-1h4l1.5 2H14a1 1 0 011 1v6a1 1 0 01-1 1H2a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>

const FOLDER_ICON_MAP: Record<string, React.FC> = {
  INBOX: InboxIcon, Inbox: InboxIcon, inbox: InboxIcon,
  Sent: SentIcon, SENT: SentIcon, sentitems: SentIcon,
  Drafts: DraftsIcon, drafts: DraftsIcon, DRAFT: DraftsIcon,
  Trash: TrashIcon, deleteditems: TrashIcon,
  Junk: SpamIcon, junkemail: SpamIcon, Spam: SpamIcon,
}

const ACCOUNT_COLOR: Record<string, string> = {
  gmail: 'bg-red-500', outlook: 'bg-blue-500', imap: 'bg-amber-500',
}

const DEFAULT_FOLDERS = [
  { name: 'Inbox',  path: 'INBOX'  },
  { name: 'Sent',   path: 'Sent'   },
  { name: 'Drafts', path: 'Drafts' },
  { name: 'Trash',  path: 'Trash'  },
]

export function Sidebar() {
  const {
    accounts, setAccounts, removeAccount,
    currentAccountId, currentFolder,
    setCurrentAccount, setCurrentFolder,
    folders, setFolders,
    emails, setEmails, setLoadingEmails,
    openCompose, setShowAccountModal,
  } = useEmailStore()

  useEffect(() => {
    accountsApi.list().then(setAccounts).catch(console.error)
  }, [])

  useEffect(() => {
    if (!currentAccountId) return
    const account = accounts.find(a => a.id === currentAccountId)
    if (!account || folders[currentAccountId]) return
    emailsApi.getFolders(currentAccountId)
      .then(f => setFolders(currentAccountId, f))
      .catch(() => setFolders(currentAccountId, DEFAULT_FOLDERS))
  }, [currentAccountId, accounts])

  const handleFolderClick = async (accountId: string, folderPath: string) => {
    setCurrentAccount(accountId)
    setCurrentFolder(folderPath)
    setLoadingEmails(true)
    try {
      setEmails(await emailsApi.list(accountId, folderPath))
    } catch (err) { console.error(err) }
    finally { setLoadingEmails(false) }
  }

  const handleDeleteAccount = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Remove this email account?')) return
    try {
      await accountsApi.remove(id)
      removeAccount(id)
      if (currentAccountId === id) { setCurrentAccount(null); setEmails([]) }
    } catch (err) { console.error(err) }
  }

  const unreadCount = (accountId: string, folderPath: string) =>
    emails.filter(e => e.accountId === accountId && e.folder === folderPath && !e.read).length

  return (
    <aside className="flex flex-col h-full bg-[#f6f8fa] dark:bg-[#161b22] border-r border-[#d0d7de] dark:border-[#30363d] w-52 flex-shrink-0">
      {/* Compose */}
      <div className="p-3">
        <button
          onClick={() => openCompose()}
          className="w-full flex items-center justify-center gap-2 bg-[#f59e0b] text-[#0d1117] rounded-md px-3 py-2 text-xs font-bold hover:bg-[#fbbf24] transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          New Message
        </button>
      </div>

      {/* Account list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {accounts.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <div className="w-10 h-10 rounded-full bg-[#eaeef2] dark:bg-[#21262d] flex items-center justify-center mx-auto mb-3 text-[#818b98] dark:text-[#484f58]">
              <InboxIcon />
            </div>
            <p className="text-[#656d76] dark:text-[#8b949e] text-xs mb-2">No accounts yet</p>
            <button onClick={() => setShowAccountModal(true)} className="text-[#f59e0b] text-xs hover:underline">
              Add an account
            </button>
          </div>
        ) : (
          accounts.map(account => {
            const accountFolders = folders[account.id] || DEFAULT_FOLDERS
            const isActive = currentAccountId === account.id
            const initials = (account.name || account.email).slice(0, 2).toUpperCase()
            const dotColor = ACCOUNT_COLOR[account.type] || 'bg-gray-500'

            return (
              <div key={account.id} className="mb-1">
                <div
                  className={`flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer group transition-colors
                    ${isActive ? 'bg-[#eaeef2] dark:bg-[#21262d]' : 'hover:bg-[#eaeef2] dark:hover:bg-[#1c2128]'}`}
                  onClick={() => handleFolderClick(account.id, 'INBOX')}
                >
                  <div className={`w-6 h-6 rounded-full ${dotColor} flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0`}>
                    {initials}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-semibold text-[#1f2328] dark:text-[#e6edf3] truncate">{account.name || account.email}</div>
                    <div className="text-[10px] text-[#656d76] dark:text-[#8b949e] truncate">{account.email}</div>
                  </div>
                  <button
                    onClick={(e) => handleDeleteAccount(account.id, e)}
                    className="opacity-0 group-hover:opacity-100 text-[#818b98] dark:text-[#484f58] hover:text-[#cf222e] dark:hover:text-[#f85149] p-0.5 rounded transition-all"
                    title="Remove account"
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                  </button>
                </div>

                {isActive && (
                  <div className="mt-0.5 ml-1">
                    {accountFolders.map(folder => {
                      const isActiveFolder = currentFolder === folder.path
                      const unread = isActiveFolder ? 0 : unreadCount(account.id, folder.path)
                      const Icon = FOLDER_ICON_MAP[folder.name] || FOLDER_ICON_MAP[folder.path] || FolderIcon

                      return (
                        <button
                          key={folder.path}
                          onClick={() => handleFolderClick(account.id, folder.path)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs rounded-md transition-colors mb-0.5
                            ${isActiveFolder
                              ? 'bg-[rgba(245,158,11,0.12)] text-[#b45309] dark:text-[#f59e0b] font-semibold'
                              : 'text-[#656d76] dark:text-[#8b949e] hover:bg-[#eaeef2] dark:hover:bg-[#1c2128] hover:text-[#1f2328] dark:hover:text-[#e6edf3]'
                            }`}
                        >
                          <span className={isActiveFolder ? 'text-[#b45309] dark:text-[#f59e0b]' : 'text-[#818b98] dark:text-[#484f58]'}>
                            <Icon />
                          </span>
                          <span className="flex-1 truncate">{folder.name}</span>
                          {unread > 0 && (
                            <span className="text-[9px] font-bold bg-[#f59e0b] text-[#0d1117] rounded-full px-1.5 py-0.5 leading-none">
                              {unread > 99 ? '99+' : unread}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Add account */}
      <div className="p-3 border-t border-[#d0d7de] dark:border-[#30363d]">
        <button
          onClick={() => setShowAccountModal(true)}
          className="w-full flex items-center gap-2 px-2 py-2 text-xs text-[#656d76] dark:text-[#8b949e] hover:text-[#f59e0b] hover:bg-[#eaeef2] dark:hover:bg-[#1c2128] rounded-md transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M7 4v6M4 7h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          Add Account
        </button>
      </div>
    </aside>
  )
}
