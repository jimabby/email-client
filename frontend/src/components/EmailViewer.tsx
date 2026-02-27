import { format, parseISO } from 'date-fns'
import DOMPurify from 'dompurify'
import { useEmailStore } from '../store/emailStore'

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

export function EmailViewer() {
  const { selectedEmail, selectedEmailBody, isLoadingBody, openCompose } = useEmailStore()

  if (!selectedEmail) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-white dark:bg-[#0d1117] text-center p-8">
        <div className="w-16 h-16 rounded-full bg-[#f6f8fa] dark:bg-[#161b22] border border-[#d0d7de] dark:border-[#30363d] flex items-center justify-center mb-4">
          <svg width="28" height="28" viewBox="0 0 60 40" fill="none">
            <path d="M16,13 C11,8 4,9 2,15"  stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" strokeOpacity="0.4"/>
            <path d="M16,19 C11,14 4,15 2,20" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeOpacity="0.4"/>
            <path d="M44,13 C49,8 56,9 58,15"  stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" strokeOpacity="0.4"/>
            <path d="M44,19 C49,14 56,15 58,20" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeOpacity="0.4"/>
            <rect x="15" y="8" width="30" height="24" rx="3" fill="#eaeef2" className="dark:fill-[#21262d]"/>
            <path d="M15,8 L30,22 L45,8" fill="none" stroke="#d0d7de" strokeWidth="1.3" strokeLinejoin="round"/>
          </svg>
        </div>
        <h3 className="text-base font-semibold text-[#1f2328] dark:text-[#e6edf3] mb-1">Select a message</h3>
        <p className="text-[#656d76] dark:text-[#8b949e] text-xs">Choose an email from the list to read it here</p>
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

  const handleForward = () => openCompose({
    accountId: selectedEmail.accountId,
    subject: `Fwd: ${selectedEmail.subject.replace(/^Fwd:\s*/i, '')}`,
    body: body ? `\n\n-------- Forwarded Message --------\nFrom: ${body.from}\nDate: ${body.date}\nSubject: ${body.subject}\n\n${body.text || ''}` : ''
  })

  const sanitizedHtml = body?.html
    ? DOMPurify.sanitize(body.html, {
        ALLOWED_TAGS: ['p','div','span','a','b','i','em','strong','br','ul','ol','li','h1','h2','h3','h4','h5','h6','table','tr','td','th','tbody','thead','img','blockquote','pre','code','hr','font'],
        ALLOWED_ATTR: ['href','src','alt','class','style','target','rel','colspan','rowspan','width','height','color','size']
      })
    : null

  const toolBtn = 'flex items-center gap-1.5 px-3 py-1.5 text-xs text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors'

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#0d1117]">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-[#d0d7de] dark:border-[#30363d] bg-[#f6f8fa] dark:bg-[#161b22]">
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
        <div className="flex-1" />
        <button className="p-1.5 text-[#818b98] dark:text-[#484f58] hover:text-[#cf222e] dark:hover:text-[#f85149] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors" title="Delete">
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
      <div className="flex-1 overflow-y-auto px-6 py-5">
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
                <div key={i} className="flex items-center gap-2 bg-[#f6f8fa] dark:bg-[#161b22] border border-[#d0d7de] dark:border-[#30363d] rounded-md px-3 py-2 text-xs">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 4L6 8.5a2 2 0 01-3-2.5L8 1a3 3 0 014 4.5L5.5 11A4 4 0 01.5 5.5L6 0" stroke="#f59e0b" strokeWidth="1.2" strokeLinecap="round"/></svg>
                  <span className="text-[#24292f] dark:text-[#c9d1d9]">{att.filename}</span>
                  <span className="text-[#818b98] dark:text-[#484f58]">({Math.round(att.size / 1024)}KB)</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
