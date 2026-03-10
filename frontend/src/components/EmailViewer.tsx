import { useEffect, useRef, useState } from 'react'
import { format, parseISO } from 'date-fns'
import DOMPurify from 'dompurify'
import { useEmailStore } from '../store/emailStore'
import { emailsApi } from '../api/client'

function formatFullDate(dateStr: string): string {
  try { return format(parseISO(dateStr), 'EEEE, MMMM d, yyyy h:mm a') }
  catch { return dateStr }
}

function getInitials(from: string): string {
  const name = from.replace(/<.*>/, '').trim()
  if (!name) return '?'
  const parts = name.split(' ')
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

const StarIcon = ({ filled }: { filled?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill={filled ? '#f59e0b' : 'none'}>
    <path d="M8 1l1.9 3.8 4.2.6-3 3 .7 4.2L8 10.5l-3.8 2.1.7-4.2-3-3 4.2-.6L8 1z"
      stroke="#f59e0b" strokeWidth="1.3" strokeLinejoin="round"/>
  </svg>
)

export function EmailViewer() {
  const {
    selectedEmail, selectedEmailBody, isLoadingBody,
    openCompose, removeEmail, showNotification,
    toggleStarLocal, markEmailUnread, setSelectedEmail,
    folders, currentAccountId, currentFolder,
  } = useEmailStore()

  const [showMoveMenu, setShowMoveMenu] = useState(false)
  const [previewOpen, setPreviewOpen] = useState<Record<number, boolean>>({})
  const previewUrlRef = useRef<Record<number, string>>({})

  useEffect(() => {
    return () => {
      const urls = previewUrlRef.current
      for (const key of Object.keys(urls)) {
        try { URL.revokeObjectURL(urls[Number(key)]) } catch {}
      }
      previewUrlRef.current = {}
    }
  }, [])

  useEffect(() => {
    setPreviewOpen({})
    const urls = previewUrlRef.current
    for (const key of Object.keys(urls)) {
      try { URL.revokeObjectURL(urls[Number(key)]) } catch {}
    }
    previewUrlRef.current = {}
  }, [selectedEmail?.id])

  if (!selectedEmail) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-white dark:bg-[#0d1117] text-center p-8 select-none">
        <div className="relative mb-5">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-[#fef3c7] to-[#fde68a] dark:from-[#1c2128] dark:to-[#21262d] border border-[#f59e0b]/20 dark:border-[#30363d] flex items-center justify-center shadow-sm">
            <svg width="40" height="27" viewBox="0 0 60 40" fill="none">
              <path d="M16,13 C11,8 4,9 2,15"  stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round"/>
              <path d="M16,19 C11,14 4,15 2,20" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeOpacity="0.6"/>
              <path d="M44,13 C49,8 56,9 58,15"  stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round"/>
              <path d="M44,19 C49,14 56,15 58,20" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeOpacity="0.6"/>
              <rect x="15" y="8" width="30" height="24" rx="3" fill="url(#emptyGold)"/>
              <path d="M15,8 L30,22 L45,8" fill="none" stroke="#92400e" strokeWidth="1.3" strokeLinejoin="round" strokeOpacity="0.5"/>
              <defs>
                <linearGradient id="emptyGold" x1="15" y1="8" x2="45" y2="32" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#fbbf24"/>
                  <stop offset="100%" stopColor="#d97706"/>
                </linearGradient>
              </defs>
            </svg>
          </div>
        </div>
        <h3 className="text-[15px] font-semibold text-[#1f2328] dark:text-[#e6edf3] mb-1.5">No message selected</h3>
        <p className="text-[#818b98] dark:text-[#8b949e] text-xs leading-relaxed max-w-[180px]">Choose an email from the list to read it here</p>
      </div>
    )
  }

  if (isLoadingBody) {
    return (
      <div className="flex flex-col h-full bg-white dark:bg-[#0d1117]">
        <div className="p-6 border-b border-[#d0d7de] dark:border-[#30363d]">
          <div className="h-5 bg-[#eaeef2] dark:bg-[#21262d] rounded w-3/4 animate-pulse mb-4" />
          <div className="h-3.5 bg-[#eaeef2] dark:bg-[#21262d] rounded w-1/2 animate-pulse mb-2" />
          <div className="h-3.5 bg-[#eaeef2] dark:bg-[#21262d] rounded w-1/3 animate-pulse" />
        </div>
        <div className="p-6 space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-3 bg-[#eaeef2] dark:bg-[#21262d] rounded animate-pulse" style={{ width: `${90 - i * 10}%` }} />
          ))}
        </div>
      </div>
    )
  }

  const body = selectedEmailBody

  const handleReply = () => openCompose({
    accountId: selectedEmail.accountId,
    to: selectedEmail.from,
    subject: `Re: ${selectedEmail.subject.replace(/^Re:\s*/i, '')}`,
    replyTo: body ? { id: selectedEmail.id, from: body.from, to: body.to, subject: body.subject, date: body.date, html: body.html, text: body.text } : undefined
  })

  const handleDelete = async () => {
    if (!selectedEmail) return
    try {
      await emailsApi.delete(selectedEmail.accountId, selectedEmail.id, selectedEmail.folder)
      removeEmail(selectedEmail.id)
      showNotification('success', 'Email deleted')
    } catch {
      showNotification('error', 'Failed to delete email')
    }
  }

  const handleForward = () => openCompose({
    accountId: selectedEmail.accountId,
    subject: `Fwd: ${selectedEmail.subject.replace(/^Fwd:\s*/i, '')}`,
    body: body ? `\n\n-------- Forwarded Message --------\nFrom: ${body.from}\nDate: ${body.date}\nSubject: ${body.subject}\n\n${body.text || ''}` : ''
  })

  const handleStar = async () => {
    const newStarred = !selectedEmail.starred
    toggleStarLocal(selectedEmail.id)
    try {
      await emailsApi.star(selectedEmail.accountId, selectedEmail.id, newStarred, selectedEmail.folder)
    } catch {
      toggleStarLocal(selectedEmail.id) // revert
      showNotification('error', 'Failed to update star')
    }
  }

  const handleMarkUnread = async () => {
    try {
      await emailsApi.markUnread(selectedEmail.accountId, selectedEmail.id, selectedEmail.folder)
      markEmailUnread(selectedEmail.id)
      setSelectedEmail(null)
      showNotification('success', 'Marked as unread')
    } catch {
      showNotification('error', 'Failed to mark as unread')
    }
  }

  const handleMove = async (targetFolder: string) => {
    setShowMoveMenu(false)
    try {
      await emailsApi.move(selectedEmail.accountId, selectedEmail.id, targetFolder, selectedEmail.folder)
      removeEmail(selectedEmail.id)
      showNotification('success', `Moved to ${targetFolder}`)
    } catch {
      showNotification('error', 'Failed to move email')
    }
  }

  const sanitizedHtml = body?.html
    ? DOMPurify.sanitize(body.html, {
        ALLOWED_TAGS: ['p','div','span','a','b','i','em','strong','br','ul','ol','li','h1','h2','h3','h4','h5','h6','table','tr','td','th','tbody','thead','img','blockquote','pre','code','hr','font'],
        ALLOWED_ATTR: ['href','src','alt','class','style','target','rel','colspan','rowspan','width','height','color','size']
      })
    : null

  const toolBtn = 'flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors'
  const iconBtn = 'p-1.5 text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors'
  const divider = <div className="w-px h-4 bg-[#d0d7de] dark:bg-[#30363d] mx-0.5 flex-shrink-0" />

  const accountFolders = (currentAccountId ? folders[currentAccountId] : null) || []
  const movableFolders = accountFolders.filter(f => f.path !== currentFolder && f.path !== '__starred__')

  const isPreviewable = (att: { filename: string; contentType: string; content?: string | null }) => {
    const type = (att.contentType || '').toLowerCase()
    const name = (att.filename || '').toLowerCase()
    return type.startsWith('image/') || type === 'application/pdf' || name.endsWith('.pdf')
  }

  const getPreviewUrl = (att: { filename: string; contentType: string; content?: string | null }, i: number) => {
    if (previewUrlRef.current[i]) return previewUrlRef.current[i]
    if (!att.content) return ''
    const bytes = Uint8Array.from(atob(att.content), c => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: att.contentType || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    previewUrlRef.current[i] = url
    return url
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#0d1117]">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-3 py-2 border-b border-[#d0d7de] dark:border-[#30363d] bg-[#f6f8fa] dark:bg-[#161b22]">
        {/* Reply group */}
        <button onClick={handleReply} className={toolBtn}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M5 3L1 6.5M1 6.5L5 10M1 6.5h8a3 3 0 010 6h-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Reply
        </button>
        <button
          onClick={() => openCompose({ accountId: selectedEmail.accountId, to: selectedEmail.to?.join(', ') || '', subject: selectedEmail.subject, body: '', replyTo: body ? { id: selectedEmail.id, from: body.from, to: body.to, subject: body.subject, date: body.date, html: body.html, text: body.text } : undefined })}
          className={toolBtn}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M4 3L0 6.5M0 6.5L4 10M0 6.5h7M8 3L12 6.5M12 6.5L8 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Reply All
        </button>
        <button onClick={handleForward} className={toolBtn}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M8 3l4 3.5M12 6.5L8 10M12 6.5H4a3 3 0 000 6h1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Forward
        </button>

        {divider}

        {/* Actions group */}
        <button
          onClick={handleStar}
          title={selectedEmail.starred ? 'Unstar' : 'Star'}
          className={`${iconBtn} ${selectedEmail.starred ? '!text-[#f59e0b]' : ''}`}
        >
          <StarIcon filled={selectedEmail.starred} />
        </button>

        <button onClick={handleMarkUnread} title="Mark as unread" className={iconBtn}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4a1 1 0 011-1h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M2 4l6 5 6-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="13" cy="4" r="2.5" fill="#f59e0b"/>
          </svg>
        </button>

        {movableFolders.length > 0 && (
          <div className="relative">
            <button onClick={() => setShowMoveMenu(v => !v)} title="Move to folder" className={iconBtn}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M1 4a1 1 0 011-1h4l1.5 2H14a1 1 0 011 1v6a1 1 0 01-1 1H2a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                <path d="M8 8v4M6 10l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {showMoveMenu && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-[#161b22] border border-[#d0d7de] dark:border-[#30363d] rounded-xl shadow-2xl z-20 py-1.5 overflow-hidden">
                <div className="px-3 py-1 text-[9px] font-bold text-[#818b98] dark:text-[#484f58] uppercase tracking-widest">Move to</div>
                {movableFolders.map(f => (
                  <button
                    key={f.path}
                    onClick={() => handleMove(f.path)}
                    className="w-full text-left px-3 py-2 text-xs text-[#24292f] dark:text-[#c9d1d9] hover:bg-[#f6f8fa] dark:hover:bg-[#21262d] transition-colors"
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {divider}

        {/* Delete */}
        <button onClick={handleDelete} className="p-1.5 text-[#818b98] dark:text-[#484f58] hover:text-[#cf222e] dark:hover:text-[#f85149] hover:bg-[#fff0ee] dark:hover:bg-[#f85149]/10 rounded-md transition-colors" title="Delete">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6L12 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>

      {/* Header */}
      <div className="px-6 py-5 border-b border-[#d0d7de] dark:border-[#30363d]">
        <h1 className="text-lg font-semibold text-[#1f2328] dark:text-[#e6edf3] mb-4 leading-snug">
          {selectedEmail.subject || '(no subject)'}
        </h1>
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-[#f59e0b] text-[#0d1117] flex items-center justify-center text-xs font-bold flex-shrink-0">
            {getInitials(selectedEmail.from)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-4">
              <span className="font-semibold text-[#1f2328] dark:text-[#e6edf3] text-sm">{selectedEmail.from}</span>
              <span className="text-xs text-[#818b98] dark:text-[#484f58] flex-shrink-0">
                {body?.date ? formatFullDate(body.date) : formatFullDate(selectedEmail.date)}
              </span>
            </div>
            {body?.to && <div className="text-xs text-[#656d76] dark:text-[#8b949e] mt-0.5"><span className="text-[#818b98] dark:text-[#484f58]">To: </span>{body.to}</div>}
            {body?.cc && <div className="text-xs text-[#656d76] dark:text-[#8b949e]"><span className="text-[#818b98] dark:text-[#484f58]">Cc: </span>{body.cc}</div>}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5" onClick={() => setShowMoveMenu(false)}>
        {sanitizedHtml ? (
          <div className="email-body" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
        ) : body?.text ? (
          <pre className="whitespace-pre-wrap font-sans text-sm text-[#24292f] dark:text-[#c9d1d9] leading-relaxed">{body.text}</pre>
        ) : (
          <p className="text-[#818b98] dark:text-[#484f58] italic text-sm">No content</p>
        )}

        {body?.attachments && body.attachments.length > 0 && (
          <div className="mt-6 border-t border-[#d0d7de] dark:border-[#30363d] pt-4">
            <div className="text-xs font-semibold text-[#656d76] dark:text-[#8b949e] mb-2">Attachments ({body.attachments.length})</div>
            <div className="flex flex-wrap gap-2">
              {body.attachments.map((att, i) => (
                <div key={i} className="flex flex-col gap-2 w-full">
                  <div className="flex items-center gap-2 bg-[#f6f8fa] dark:bg-[#161b22] border border-[#d0d7de] dark:border-[#30363d] rounded-md px-3 py-2 text-xs">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 4L6 8.5a2 2 0 01-3-2.5L8 1a3 3 0 014 4.5L5.5 11A4 4 0 01.5 5.5L6 0" stroke="#f59e0b" strokeWidth="1.2" strokeLinecap="round"/></svg>
                    <span className="text-[#24292f] dark:text-[#c9d1d9]">{att.filename}</span>
                    <span className="text-[#818b98] dark:text-[#484f58]">({Math.round(att.size / 1024)}KB)</span>
                    {att.content && isPreviewable(att) && (
                      <button
                        title="Preview"
                        onClick={() => setPreviewOpen(s => ({ ...s, [i]: !s[i] }))}
                        className="text-[#0969da] hover:text-[#1f6feb] transition-colors text-[11px]"
                      >
                        {previewOpen[i] ? 'Hide' : 'Preview'}
                      </button>
                    )}
                    {att.content && (
                      <button
                        title="Download"
                        onClick={() => {
                          const bytes = Uint8Array.from(atob(att.content!), c => c.charCodeAt(0))
                          const blob = new Blob([bytes], { type: att.contentType })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url; a.download = att.filename; a.click()
                          URL.revokeObjectURL(url)
                        }}
                        className="text-[#f59e0b] hover:text-[#d97706] transition-colors"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v7M3 5l3 3 3-3M1 10h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      </button>
                    )}
                  </div>
                  {att.content && previewOpen[i] && isPreviewable(att) && (
                    <div className="border border-[#d0d7de] dark:border-[#30363d] rounded-md overflow-hidden bg-white dark:bg-[#0d1117] w-full">
                      {att.contentType?.toLowerCase().startsWith('image/') ? (
                        <img src={getPreviewUrl(att, i)} alt={att.filename} className="w-full h-auto max-h-[80vh] object-contain" />
                      ) : (
                        <iframe title={att.filename} src={getPreviewUrl(att, i)} className="w-full h-[80vh]" />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
