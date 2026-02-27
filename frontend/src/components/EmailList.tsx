import { format, isToday, isYesterday, parseISO } from 'date-fns'
import { useEmailStore } from '../store/emailStore'
import { emailsApi } from '../api/client'
import type { EmailSummary } from '../types/email'

function formatDate(dateStr: string): string {
  try {
    const date = parseISO(dateStr)
    if (isToday(date)) return format(date, 'h:mm a')
    if (isYesterday(date)) return 'Yesterday'
    return format(date, 'MMM d')
  } catch { return '' }
}

function getInitials(from: string): string {
  const name = from.replace(/<.*>/, '').trim()
  if (!name) return '?'
  const parts = name.split(' ')
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function getAvatarColor(from: string): string {
  const colors = [
    '#1d4ed8', '#7c3aed', '#059669', '#d97706',
    '#db2777', '#0891b2', '#dc2626', '#4338ca',
  ]
  let hash = 0
  for (const c of from) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff
  return colors[hash % colors.length]
}

function getSenderName(from: string): string {
  const match = from.match(/^([^<]+)</)
  if (match) return match[1].trim()
  const emailMatch = from.match(/^<?([^>]+)>?$/)
  if (emailMatch) return emailMatch[1].trim()
  return from
}

interface EmailRowProps {
  email: EmailSummary
  isSelected: boolean
  onClick: () => void
}

function EmailRow({ email, isSelected, onClick }: EmailRowProps) {
  const initials = getInitials(email.from)
  const avatarColor = getAvatarColor(email.from)

  return (
    <div
      onClick={onClick}
      className={`flex items-start gap-3 px-3 py-3 cursor-pointer border-b border-[#21262d] transition-colors relative
        ${isSelected
          ? 'bg-[#1c2128] border-l-2 border-l-[#f59e0b]'
          : 'hover:bg-[#161b22] border-l-2 border-l-transparent'
        }
      `}
    >
      {/* Avatar */}
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 mt-0.5"
        style={{ backgroundColor: avatarColor }}
      >
        {initials}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <span className={`text-xs truncate ${!email.read ? 'font-bold text-[#e6edf3]' : 'text-[#8b949e]'}`}>
            {getSenderName(email.from)}
          </span>
          <span className="text-[10px] text-[#484f58] flex-shrink-0">{formatDate(email.date)}</span>
        </div>
        <div className={`text-xs truncate ${!email.read ? 'font-semibold text-[#c9d1d9]' : 'text-[#8b949e]'}`}>
          {email.subject}
        </div>
        {email.snippet && (
          <div className="text-[11px] text-[#484f58] truncate mt-0.5">{email.snippet}</div>
        )}
      </div>

      {/* Unread dot */}
      {!email.read && (
        <div className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] flex-shrink-0 mt-2" />
      )}
    </div>
  )
}

export function EmailList() {
  const {
    emails, isLoadingEmails,
    selectedEmail, setSelectedEmail,
    setSelectedEmailBody, setLoadingBody,
    markEmailRead, currentAccountId, currentFolder
  } = useEmailStore()

  const handleSelectEmail = async (email: EmailSummary) => {
    setSelectedEmail(email)
    markEmailRead(email.id)
    if (!currentAccountId) return
    setLoadingBody(true)
    try {
      const body = await emailsApi.getBody(currentAccountId, email.id)
      setSelectedEmailBody(body)
    } catch (err) {
      console.error('Failed to load email body:', err)
      setSelectedEmailBody(null)
    } finally {
      setLoadingBody(false)
    }
  }

  if (isLoadingEmails) {
    return (
      <div className="flex flex-col h-full bg-[#0d1117]">
        <div className="px-3 py-3 border-b border-[#30363d]">
          <div className="h-4 bg-[#21262d] rounded w-20 animate-pulse" />
        </div>
        {[...Array(8)].map((_, i) => (
          <div key={i} className="flex items-start gap-3 px-3 py-3 border-b border-[#21262d]">
            <div className="w-8 h-8 rounded-full bg-[#21262d] animate-pulse flex-shrink-0" />
            <div className="flex-1">
              <div className="h-2.5 bg-[#21262d] rounded w-3/4 animate-pulse mb-2" />
              <div className="h-2.5 bg-[#21262d] rounded w-1/2 animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  const folderLabel = currentFolder === 'INBOX' ? 'Inbox'
    : currentFolder === 'SENT' ? 'Sent'
    : currentFolder

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      {/* Header */}
      <div className="px-3 py-3 border-b border-[#30363d] flex items-center gap-3">
        <h2 className="font-semibold text-[#e6edf3] text-sm">{folderLabel}</h2>
        <span className="text-[#484f58] text-xs">{emails.length}</span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {emails.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <div className="w-12 h-12 rounded-full bg-[#21262d] flex items-center justify-center mb-3">
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                <path d="M1 10h3l1.5 2h5L12 10h3V13a1 1 0 01-1 1H2a1 1 0 01-1-1v-3z" stroke="#484f58" strokeWidth="1.3" strokeLinejoin="round"/>
                <path d="M1 10V4a1 1 0 011-1h12a1 1 0 011 1v6" stroke="#484f58" strokeWidth="1.3" strokeLinejoin="round"/>
              </svg>
            </div>
            <p className="text-[#8b949e] text-xs">
              {currentAccountId ? 'No emails in this folder' : 'Select an account to view emails'}
            </p>
          </div>
        ) : (
          emails.map(email => (
            <EmailRow
              key={email.id}
              email={email}
              isSelected={selectedEmail?.id === email.id}
              onClick={() => handleSelectEmail(email)}
            />
          ))
        )}
      </div>
    </div>
  )
}
