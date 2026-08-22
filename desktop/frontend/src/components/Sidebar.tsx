import { useEffect } from 'react'
import { useEmailStore } from '../store/emailStore'
import { accountsApi, emailsApi } from '../api/client'

const InboxIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 10h3l1.5 2h5L12 10h3V13a1 1 0 01-1 1H2a1 1 0 01-1-1v-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M1 10V4a1 1 0 011-1h12a1 1 0 011 1v6" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
const SentIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13.5 2.5L7 9M13.5 2.5L9 14l-2-5-5-2 11.5-4.5z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
const DraftsIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6l-3-4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M10 2v4h4M6 9h4M6 11.5h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
const TrashIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6L12 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
const SpamIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/><path d="M8 5v4M8 11v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
const SnoozeIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.3"/><path d="M6 7h4l-4 3.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 1.5L2.5 3.5M11 1.5l2.5 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
const FolderIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 4a1 1 0 011-1h4l1.5 2H14a1 1 0 011 1v6a1 1 0 01-1 1H2a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
const OutboxIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 10h3l1.5 2h5L12 10h3v3a1 1 0 01-1 1H2a1 1 0 01-1-1v-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M8 8V1M5.5 3.5L8 1l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
const RulesIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h8M2 12h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="13" cy="11" r="2" stroke="currentColor" strokeWidth="1.2"/></svg>
const StarIcon = ({ filled }: { filled?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'} className="text-accent">
    <path d="M8 1l1.9 3.8 4.2.6-3 3 .7 4.2L8 10.5l-3.8 2.1.7-4.2-3-3 4.2-.6L8 1z"
      stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
  </svg>
)

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

/**
 * One row in the folder list. Starred, Snoozed, Drafts, and every real folder
 * were four hand-maintained copies of the same markup; they are one component
 * now so the selected state can only ever look one way.
 */
function NavItem({ icon, label, active, badge = 0, badgeTone = 'accent', onClick, onDoubleClick }: {
  icon: React.ReactNode
  label: string
  active?: boolean
  badge?: number
  badgeTone?: 'accent' | 'neutral'
  onClick: () => void
  onDoubleClick?: (e: React.MouseEvent) => void
}) {
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      aria-current={active ? 'page' : undefined}
      className={`w-full flex items-center gap-2.5 px-2.5 py-[7px] text-left text-[12.5px] rounded-lg
                  transition-colors duration-150 relative
        ${active
          ? 'bg-accent/14 text-accent-ink font-semibold'
          : 'text-ink-2 hover:bg-ink/5 hover:text-ink'
        }`}
    >
      <span className={`flex-shrink-0 ${active ? 'text-accent-ink' : 'text-ink-3'}`}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {badge > 0 && (
        <span
          className={`text-[10px] font-semibold rounded-full px-1.5 py-px leading-[1.4] tabular-nums flex-shrink-0
            ${badgeTone === 'accent' ? 'bg-accent text-[#201500]' : 'bg-ink/12 text-ink-2'}`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}

const DEFAULT_FOLDERS = [
  { name: 'Inbox', path: 'INBOX' },
  { name: 'Sent', path: 'Sent' },
  { name: 'Drafts', path: 'Drafts' },
  { name: 'Trash', path: 'Trash' },
]

export function Sidebar() {
  const {
    accounts, setAccounts, removeAccount,
    currentAccountId, currentFolder,
    setCurrentAccount, setCurrentFolder,
    folders, setFolders,
    emails, setEmails, setLoadingEmails, setNextToken,
    openCompose, setShowAccountModal,
    snoozes, drafts, setShowDraftsModal,
    setUnreadCounts, getUnreadCount, outbox, setOutbox, setShowOutboxModal, setShowRulesModal,
  } = useEmailStore()

  useEffect(() => {
    accountsApi.list()
      .then(list => {
        setAccounts(list)
        // Select the first account automatically so the app isn't empty on launch.
        if (list.length && !useEmailStore.getState().currentAccountId) {
          handleFolderClick(list[0].id, 'INBOX')
        }
      })
      .catch(console.error)
  }, [])

  // Real unread totals from the provider. Counting the loaded page could only
  // ever describe the folder the user happened to be looking at.
  useEffect(() => {
    if (!accounts.length) return
    const folderPaths = Array.from(new Set(
      accounts.flatMap(a => (folders[a.id] || DEFAULT_FOLDERS).map(f => f.path)).concat('INBOX')
    )).filter(p => !p.startsWith('__')).slice(0, 12)

    const refresh = () => {
      emailsApi.unreadCounts(folderPaths).then(setUnreadCounts).catch(() => {})
    }
    refresh()
    const timer = setInterval(refresh, 60_000)
    return () => clearInterval(timer)
  }, [accounts, folders])

  // Keep the outbox badge current so a stuck message is visible.
  useEffect(() => {
    const refresh = () => emailsApi.getOutbox().then(setOutbox).catch(() => {})
    refresh()
    const timer = setInterval(refresh, 20_000)
    return () => clearInterval(timer)
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
    const alreadyHere = currentAccountId === accountId && currentFolder === folderPath
    if (alreadyHere && emails.length > 0) return
    if (!alreadyHere) {
      setCurrentAccount(accountId)
      setCurrentFolder(folderPath)
    }
    if (folderPath === '__starred__') return // starred is a local filter — no fetch needed
    setLoadingEmails(true)
    try {
      const { emails: fetched, nextToken } = await emailsApi.list(accountId, folderPath)
      setEmails(fetched)
      setNextToken(nextToken)
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

  // Provider-reported totals, with the loaded page as a fallback for folders
  // the counts request hasn't covered yet.
  const unreadCount = (accountId: string, folderPath: string) => {
    const fromServer = getUnreadCount(accountId, folderPath)
    if (fromServer) return fromServer
    return emails.filter(e => e.accountId === accountId && e.folder === folderPath && !e.read).length
  }

  const starredCount = (accountId: string) =>
    emails.filter(e => e.accountId === accountId && e.starred).length

  const pendingOutbox = outbox.filter(i =>
    i.status === 'pending' || i.status === 'retrying' || i.status === 'failed' || i.status === 'sending'
  ).length
  const failedOutbox = outbox.filter(i => i.status === 'failed').length

  const snoozedCount = (accountId: string) =>
    snoozes.filter(s => s.accountId === accountId).length

  const draftsCount = (accountId: string) =>
    drafts.filter(d => d.accountId === accountId).length

  return (
    <aside
      className="flex flex-col h-full glass rounded-2xl shadow-pane rim-top w-[var(--sidebar-width)] flex-shrink-0 overflow-hidden"
      role="navigation"
      aria-label="Email accounts and folders"
    >
      {/* Compose */}
      <div className="p-2.5">
        <button
          onClick={() => openCompose()}
          aria-label="Compose new message"
          className="btn-accent w-full flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-semibold tracking-[-0.005em]"
        >
          <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
            <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          New message
        </button>
      </div>

      {/* Account list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {accounts.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <div className="w-11 h-11 rounded-2xl bg-ink/6 flex items-center justify-center mx-auto mb-3 text-ink-3">
              <InboxIcon />
            </div>
            <p className="text-ink-2 text-[12.5px] mb-2">No accounts yet</p>
            <button onClick={() => setShowAccountModal(true)} className="text-accent-ink text-[12.5px] font-medium hover:underline">
              Add an account
            </button>
          </div>
        ) : (
          accounts.map(account => {
            const accountFolders = folders[account.id] || DEFAULT_FOLDERS
            const isActive = currentAccountId === account.id
            const initials = (account.name || account.email).slice(0, 2).toUpperCase()
            const dotColor = ACCOUNT_COLOR[account.type] || 'bg-gray-500'
            const starred = starredCount(account.id)

            return (
              <div key={account.id} className="mb-1.5">
                <div
                  className={`flex items-center gap-2.5 px-2 py-2 rounded-xl cursor-pointer group transition-colors duration-150
                    ${isActive ? 'bg-ink/6' : 'hover:bg-ink/4'}`}
                  onClick={() => handleFolderClick(account.id, 'INBOX')}
                >
                  <div className={`w-7 h-7 rounded-full ${dotColor} flex items-center justify-center text-[10px] font-semibold text-white flex-shrink-0 shadow-sm`}>
                    {initials}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-semibold text-ink truncate leading-tight">{account.name || account.email}</div>
                    <div className="text-[11px] text-ink-3 truncate leading-tight">{account.email}</div>
                  </div>
                  <button
                    onClick={(e) => handleDeleteAccount(account.id, e)}
                    className="opacity-0 group-hover:opacity-100 text-ink-3 hover:text-danger p-1 rounded-md transition-all"
                    title="Remove account"
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                    </svg>
                  </button>
                </div>

                {isActive && (
                  <div className="mt-1 space-y-px animate-fade">
                    <NavItem
                      icon={<StarIcon filled={currentFolder === '__starred__'} />}
                      label="Starred"
                      active={currentFolder === '__starred__'}
                      badge={starred}
                      onClick={() => { setCurrentAccount(account.id); setCurrentFolder('__starred__') }}
                    />

                    <NavItem
                      icon={<SnoozeIcon />}
                      label="Snoozed"
                      active={currentFolder === '__snoozed__'}
                      badge={snoozedCount(account.id)}
                      badgeTone="neutral"
                      onClick={() => { setCurrentAccount(account.id); setCurrentFolder('__snoozed__') }}
                    />

                    {/* Distinct from the provider's own Drafts folder further
                        down the list: these are unsent drafts held on this
                        machine, which is why the label has to differ. */}
                    <NavItem
                      icon={<DraftsIcon />}
                      label="Local drafts"
                      badge={draftsCount(account.id)}
                      badgeTone="neutral"
                      onClick={() => { setCurrentAccount(account.id); setShowDraftsModal(true) }}
                    />

                    {accountFolders.map(folder => {
                      const isActiveFolder = currentFolder === folder.path
                      const Icon = FOLDER_ICON_MAP[folder.name] || FOLDER_ICON_MAP[folder.path] || FolderIcon

                      return (
                        <NavItem
                          key={folder.path}
                          icon={<Icon />}
                          label={folder.name}
                          active={isActiveFolder}
                          badge={isActiveFolder ? 0 : unreadCount(account.id, folder.path)}
                          onClick={() => handleFolderClick(account.id, folder.path)}
                          onDoubleClick={async (e) => {
                            e.preventDefault()
                            const name = prompt('Rename folder', folder.name)
                            if (!name || name === folder.name) return
                            try { const updated = await emailsApi.renameFolder(account.id, folder.path, name); setFolders(account.id, accountFolders.map(f => f.path === folder.path ? updated : f)) } catch (err) { console.error(err) }
                          }}
                        />
                      )
                    })}

                    <button
                      onClick={async () => {
                        const name = prompt('New folder name')
                        if (!name) return
                        try { const created = await emailsApi.createFolder(account.id, name); setFolders(account.id, [...accountFolders, created]) } catch (err) { console.error(err) }
                      }}
                      title="Double-click a folder to rename it"
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink-3 hover:text-accent-ink rounded-lg hover:bg-ink/4 transition-colors"
                    >
                      <span className="w-[14px] flex justify-center text-base leading-none">+</span>
                      New folder
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Outbox, rules, add account */}
      <div className="p-2 border-t border-line/40 space-y-px">
        <button
          onClick={() => setShowOutboxModal(true)}
          className={`w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[12.5px] rounded-lg transition-colors duration-150
            ${failedOutbox ? 'text-danger hover:bg-danger/10' : 'text-ink-2 hover:bg-ink/5 hover:text-ink'}`}
        >
          <span className={failedOutbox ? '' : 'text-ink-3'}><OutboxIcon /></span>
          <span className="flex-1 text-left">Outbox</span>
          {pendingOutbox > 0 && (
            <span className={`text-[10px] font-semibold rounded-full px-1.5 py-px leading-[1.4] tabular-nums ${
              failedOutbox ? 'bg-danger text-white' : 'bg-accent text-[#201500]'
            }`}>
              {pendingOutbox}
            </span>
          )}
        </button>

        <button
          onClick={() => setShowRulesModal(true)}
          className="w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[12.5px] text-ink-2 hover:text-ink hover:bg-ink/5 rounded-lg transition-colors duration-150"
        >
          <span className="text-ink-3"><RulesIcon /></span>
          <span className="flex-1 text-left">Rules</span>
        </button>

        <button
          onClick={() => setShowAccountModal(true)}
          className="w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[12.5px] text-ink-2 hover:text-ink hover:bg-ink/5 rounded-lg transition-colors duration-150"
        >
          <span className="text-ink-3">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M7 4v6M4 7h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </span>
          <span className="flex-1 text-left">Add account</span>
        </button>
      </div>
    </aside>
  )
}
