import { useEffect, useMemo, useRef, useState } from 'react'
import { format, parseISO } from 'date-fns'
import DOMPurify from 'dompurify'
import { useEmailStore } from '../store/emailStore'
import { aiApi, emailsApi } from '../api/client'
import { Avatar, bareAddress } from './Avatar'
import { readJson, writeJson } from '../lib/storage'
import type { Attachment, DraftAttachment } from '../types/email'

function formatFullDate(dateStr: string): string {
  try { return format(parseISO(dateStr), 'EEEE, MMMM d, yyyy h:mm a') }
  catch { return dateStr }
}

function normalizeSubject(subject: string): string {
  const raw = (subject || '').trim().toLowerCase()
  if (!raw) return '(no subject)'
  return raw.replace(/^(re|fw|fwd)\s*:\s*/gi, '').trim() || '(no subject)'
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function sanitizeEmailHtml(html: string, allowRemoteImages: boolean): { html: string; blocked: number } {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p','div','span','a','b','i','em','strong','br','ul','ol','li','h1','h2','h3','h4','h5','h6','table','tr','td','th','tbody','thead','img','blockquote','pre','code','hr','font'],
    ALLOWED_ATTR: ['href','src','alt','class','style','target','rel','colspan','rowspan','width','height','color','size']
  })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  let blocked = 0
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || ''
    const isRemote = /^https?:\/\//i.test(src) || src.startsWith('//')
    // Only treat an image as a tracking pixel when it explicitly declares a
    // 1px (or smaller) dimension. Most legitimate images omit width/height, so
    // a missing attribute must NOT be read as 0 — otherwise everything gets
    // permanently removed and "Show images" can't bring it back.
    const w = img.getAttribute('width')
    const h = img.getAttribute('height')
    const tiny = w !== null && h !== null && Number(w) <= 1 && Number(h) <= 1
    if (tiny) { img.remove(); blocked++; continue }
    if (isRemote && !allowRemoteImages) { img.removeAttribute('src'); img.setAttribute('alt', img.getAttribute('alt') || '[remote image blocked]'); blocked++ }
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[style]'))) {
    if (/url\s*\(\s*['"]?(?:https?:)?\/\//i.test(el.getAttribute('style') || '')) { el.removeAttribute('style'); blocked++ }
  }
  for (const a of Array.from(doc.querySelectorAll('a'))) { a.setAttribute('rel', 'noopener noreferrer'); a.setAttribute('target', '_blank') }
  return { html: doc.body.innerHTML, blocked }
}

function extractUnsubscribeLink(html?: string, text?: string): string | null {
  const isUnsub = (s: string) => /unsubscribe|optout|opt-out|manage\s+preferences/i.test(s)
  if (html && typeof window !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const links = Array.from(doc.querySelectorAll('a[href]'))
      for (const a of links) {
        const href = a.getAttribute('href') || ''
        const label = (a.textContent || '') + ' ' + href
        if (isUnsub(label)) return href
      }
    } catch {}
  }
  const raw = text || html || ''
  const match = raw.match(/https?:\/\/\S+/gi)
  if (match) {
    const url = match.find(u => isUnsub(u))
    if (url) return url.replace(/[)>.,]*$/, '')
  }
  return null
}

// Smart replies were cached one localStorage key per message, which grew
// without bound and could never be pruned. One bounded LRU map instead.
const SMART_REPLY_KEY = 'hermes-smart-replies'
const SMART_REPLY_LIMIT = 200

function readSmartReplyCache(): Record<string, string[]> {
  return readJson<Record<string, string[]>>(SMART_REPLY_KEY, {})
}

function readSmartReplies(emailId: string): string[] | null {
  const cached = readSmartReplyCache()[emailId]
  return Array.isArray(cached) ? cached : null
}

function writeSmartReplies(emailId: string, replies: string[]) {
  const cache = readSmartReplyCache()
  cache[emailId] = replies
  const keys = Object.keys(cache)
  for (const stale of keys.slice(0, Math.max(0, keys.length - SMART_REPLY_LIMIT))) delete cache[stale]
  writeJson(SMART_REPLY_KEY, cache)
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
    folders, currentAccountId, currentFolder, emails, accounts,
    snoozeEmailLocal, unsnoozeLocal, getArchiveFolder,
  } = useEmailStore()

  const [showMoveMenu, setShowMoveMenu] = useState(false)
  const [showSnoozeMenu, setShowSnoozeMenu] = useState(false)
  const [previewOpen, setPreviewOpen] = useState<Record<number, boolean>>({})
  const previewUrlRef = useRef<Record<number, string>>({})
  const [threadSummary, setThreadSummary] = useState<{ summary: string; keyPoints: string[]; actionItems: string[] } | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [showRemoteImages, setShowRemoteImages] = useState(false)
  const [conversationBodies, setConversationBodies] = useState<Array<{ email: typeof selectedEmail; body: NonNullable<typeof selectedEmailBody> }>>([])
  const [smartReplies, setSmartReplies] = useState<string[]>([])
  const [actions, setActions] = useState<{ title: string; kind: 'task' | 'calendar'; date?: string; details?: string }[]>([])
  const [actionsLoading, setActionsLoading] = useState(false)
  const [attachmentSummaries, setAttachmentSummaries] = useState<Record<number, string>>({})

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

  useEffect(() => {
    setThreadSummary(null)
    setSummaryError(null)
    setSummaryLoading(false)
    setShowRemoteImages(false)
    setActions([])
    setAttachmentSummaries({})
  }, [selectedEmail?.id])

  // Keyed on the message id only. Depending on `emails` re-ran this on every
  // background inbox refresh, re-fetching the whole conversation and firing a
  // fresh smart-replies request each time.
  const conversationCandidates = useMemo<string>(() => {
    if (!selectedEmail) return ''
    const providerThread = (selectedEmail.gmailId || selectedEmail.outlookId) ? selectedEmail.threadId : null
    return emails
      .filter(e => e.id !== selectedEmail.id && e.accountId === selectedEmail.accountId &&
        (providerThread ? e.threadId === providerThread : normalizeSubject(e.subject) === normalizeSubject(selectedEmail.subject)))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
      .slice(-9)
      .map(e => e.id)
      .join(',')
  }, [emails, selectedEmail?.id])

  useEffect(() => {
    if (!selectedEmail || !selectedEmailBody) { setConversationBodies([]); setSmartReplies([]); return }
    let cancelled = false

    const providerThread = (selectedEmail.gmailId || selectedEmail.outlookId) ? selectedEmail.threadId : null
    const candidateIds = conversationCandidates ? conversationCandidates.split(',') : []
    const candidates = candidateIds
      .map(id => emails.find(e => e.id === id))
      .filter((e): e is NonNullable<typeof e> => !!e)

    const conversationRequest = providerThread
      ? emailsApi.getThread(selectedEmail.accountId, providerThread)
          .then(items => items.filter(x => x.summary.id !== selectedEmail.id).map(x => ({ email: x.summary, body: x.body })))
      : Promise.all(candidates.map(async email => ({
          email,
          body: await emailsApi.getBody(email.accountId, email.id, email.folder),
        })))

    conversationRequest
      .then(items => { if (!cancelled) setConversationBodies(items) })
      .catch(() => { if (!cancelled) setConversationBodies([]) })

    const cached = readSmartReplies(selectedEmail.id)
    if (cached) {
      setSmartReplies(cached)
    } else {
      aiApi.smartReplies({
        from: selectedEmail.from,
        subject: selectedEmail.subject,
        body: selectedEmailBody.text || stripHtml(selectedEmailBody.html || ''),
      })
        .then(({ replies }) => {
          if (cancelled) return
          setSmartReplies(replies)
          writeSmartReplies(selectedEmail.id, replies)
        })
        .catch(() => {})
    }

    return () => { cancelled = true }
  }, [selectedEmail?.id, selectedEmailBody, conversationCandidates])

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

  // Gmail-style quoted original for reply bodies (plain-text lines inside a
  // blockquote — the TipTap editor handles that reliably, unlike raw email HTML).
  const buildQuoteHtml = () => {
    if (!body) return ''
    const quoted = (body.text || (body.html ? stripHtml(body.html) : '')).slice(0, 8000)
    if (!quoted.trim()) return ''
    const lines = quoted.split('\n').map(l => `<p>${escapeHtml(l)}</p>`).join('')
    const when = body.date ? formatFullDate(body.date) : ''
    return `<p></p><p>On ${escapeHtml(when)}, ${escapeHtml(body.from)} wrote:</p><blockquote>${lines}</blockquote>`
  }

  const replyToPayload = () => body
    ? {
        id: selectedEmail!.id, folder: selectedEmail!.folder,
        from: body.from, to: body.to, subject: body.subject, date: body.date, html: body.html, text: body.text,
        messageId: body.messageId, references: body.references, threadId: body.threadId,
      }
    : undefined

  const handleReply = () => openCompose({
    accountId: selectedEmail.accountId,
    to: selectedEmail.from,
    subject: `Re: ${selectedEmail.subject.replace(/^Re:\s*/i, '')}`,
    body: buildQuoteHtml(),
    replyTo: replyToPayload()
  })

  const handleSmartReply = (reply: string) => openCompose({
    accountId: selectedEmail.accountId,
    to: selectedEmail.from,
    subject: `Re: ${selectedEmail.subject.replace(/^Re:\s*/i, '')}`,
    body: `<p>${escapeHtml(reply)}</p>${buildQuoteHtml()}`,
    replyTo: replyToPayload()
  })

  // Reply All: original sender + all To recipients (minus this account) in To,
  // original Cc preserved.
  const handleReplyAll = () => {
    const self = (accounts.find(a => a.id === selectedEmail.accountId)?.email || '').toLowerCase()
    const split = (s?: string) => (s || '').split(',').map(x => x.trim()).filter(Boolean)
    const seen = new Set<string>()
    const keep = (list: string[]) => list.filter(a => {
      const addr = bareAddress(a)
      if (!addr || addr === self || seen.has(addr)) return false
      seen.add(addr)
      return true
    })
    const toList = keep([selectedEmail.from, ...split(body?.to), ...(selectedEmail.to || []).filter(Boolean)])
    const ccList = keep(split(body?.cc))
    openCompose({
      accountId: selectedEmail.accountId,
      to: (toList.length ? toList : [selectedEmail.from]).join(', '),
      cc: ccList.join(', '),
      subject: `Re: ${selectedEmail.subject.replace(/^Re:\s*/i, '')}`,
      body: buildQuoteHtml(),
      replyTo: replyToPayload()
    })
  }

  const handleDelete = async () => {
    if (!selectedEmail) return
    if (!window.confirm('Delete this email?')) return
    try {
      await emailsApi.delete(selectedEmail.accountId, selectedEmail.id, selectedEmail.folder)
      removeEmail(selectedEmail.id)
      showNotification('success', 'Email deleted')
    } catch {
      showNotification('error', 'Failed to delete email')
    }
  }

  const handleSpam = async () => {
    try { await emailsApi.reportSpam(selectedEmail.accountId, selectedEmail.id, selectedEmail.folder); removeEmail(selectedEmail.id); showNotification('success', 'Reported as spam') }
    catch { showNotification('error', 'Failed to report spam') }
  }
  const handleBlock = async () => {
    if (!confirm(`Block ${selectedEmail.from}? Future messages will go to spam.`)) return
    try { await emailsApi.blockSender(selectedEmail.accountId, selectedEmail.id, selectedEmail.from, selectedEmail.folder); removeEmail(selectedEmail.id); showNotification('success', 'Sender blocked') }
    catch { showNotification('error', 'Failed to block sender') }
  }

  const handleArchive = async () => {
    if (!selectedEmail) return
    try {
      await emailsApi.move(selectedEmail.accountId, selectedEmail.id, getArchiveFolder(selectedEmail.accountId), selectedEmail.folder)
      removeEmail(selectedEmail.id)
      showNotification('success', 'Archived')
    } catch {
      showNotification('error', 'Failed to archive email')
    }
  }

  // Forward: build real HTML (the editor collapses "\n", so the old plain-text
  // version arrived as one unreadable paragraph) and bring the attachments.
  const handleForward = async () => {
    const attachmentCount = body?.attachments?.length || 0
    if (attachmentCount) showNotification('success', `Preparing ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}…`)

    const header = body
      ? [
          `<p></p><p>-------- Forwarded Message --------</p>`,
          `<p>From: ${escapeHtml(body.from)}<br>`,
          `Date: ${escapeHtml(body.date ? formatFullDate(body.date) : '')}<br>`,
          `Subject: ${escapeHtml(body.subject || '')}<br>`,
          `To: ${escapeHtml(body.to || '')}</p>`,
        ].join('')
      : ''
    const quoted = body
      ? (body.text || stripHtml(body.html || ''))
          .split('\n')
          .map(line => `<p>${escapeHtml(line)}</p>`)
          .join('')
      : ''

    const forwardedAttachments = attachmentCount ? await collectAttachmentsForForward() : []

    openCompose({
      accountId: selectedEmail.accountId,
      subject: `Fwd: ${selectedEmail.subject.replace(/^Fwd:\s*/i, '')}`,
      body: `${header}<blockquote>${quoted}</blockquote>`,
      attachments: forwardedAttachments,
    })
  }

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

  const snoozeOptions = (): { label: string; until: Date }[] => {
    const now = new Date()
    const at = (base: Date, h: number, m = 0) => { const d = new Date(base); d.setHours(h, m, 0, 0); return d }
    const laterToday = new Date(now.getTime() + 3 * 60 * 60 * 1000)
    let thisEvening = at(now, 18)
    if (thisEvening.getTime() <= now.getTime() + 30 * 60 * 1000) thisEvening = at(new Date(now.getTime() + 86400000), 18)
    const tomorrow = at(new Date(now.getTime() + 86400000), 8)
    const weekend = (() => { const d = at(now, 8); const day = d.getDay(); const add = ((6 - day) + 7) % 7 || 7; d.setDate(d.getDate() + add); return d })()
    const nextWeek = (() => { const d = at(now, 8); const day = d.getDay(); const add = ((1 - day) + 7) % 7 || 7; d.setDate(d.getDate() + add); return d })()
    return [
      { label: 'Later today', until: laterToday },
      { label: 'This evening', until: thisEvening },
      { label: 'Tomorrow', until: tomorrow },
      { label: 'This weekend', until: weekend },
      { label: 'Next week', until: nextWeek },
    ]
  }

  const handleSnooze = async (until: Date) => {
    if (!selectedEmail) return
    setShowSnoozeMenu(false)
    const email = selectedEmail
    try {
      await emailsApi.snooze(email.accountId, email.id, until.toISOString(), email, email.folder)
      snoozeEmailLocal(email, until.toISOString())
      showNotification('success', `Snoozed until ${until.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`)
    } catch {
      showNotification('error', 'Failed to snooze email')
    }
  }

  // "Create reminder" resurfaces the email later via the same server-backed
  // snooze scheduler (a standalone reminder store had no surface that read it).
  const handleReminder = (dateHint?: string) => {
    const parsed = dateHint ? new Date(dateHint) : null
    let when = parsed && !isNaN(parsed.getTime()) && parsed.getTime() > Date.now() ? parsed : null
    if (!when) { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); when = d }
    handleSnooze(when)
  }

  const handleUnsnooze = async () => {
    if (!selectedEmail) return
    const email = selectedEmail
    try {
      await emailsApi.unsnooze(email.accountId, email.id)
      unsnoozeLocal(email.id)
      setSelectedEmail(null)
      showNotification('success', 'Email un-snoozed')
    } catch {
      showNotification('error', 'Failed to un-snooze email')
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

  const handleSummarizeThread = async () => {
    if (!selectedEmail) return
    setSummaryLoading(true)
    setSummaryError(null)
    setThreadSummary(null)
    try {
      const key = normalizeSubject(selectedEmail.subject)
      const threadEmails = emails
        .filter(e => e.accountId === selectedEmail.accountId && normalizeSubject(e.subject) === key)
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .slice(0, 8)

      const messages = await Promise.all(threadEmails.map(async (e) => {
        try {
          const b = await emailsApi.getBody(e.accountId, e.id, e.folder)
          const bodyText = b.text || (b.html ? stripHtml(b.html) : '') || e.subject || ''
          return { from: b.from || e.from, date: b.date || e.date, body: bodyText }
        } catch {
          return { from: e.from, date: e.date, body: e.subject || '' }
        }
      }))

      const result = await aiApi.summarizeThread({ subject: selectedEmail.subject, messages })
      setThreadSummary(result)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to summarize thread'
      setSummaryError(msg)
      showNotification('error', msg)
    } finally {
      setSummaryLoading(false)
    }
  }

  const handleExtractActions = async () => {
    if (!body) return
    setActionsLoading(true)
    try { setActions((await aiApi.extractActions({ subject: body.subject, body: body.text || stripHtml(body.html || '') })).actions) }
    catch { showNotification('error', 'Failed to extract actions') }
    finally { setActionsLoading(false) }
  }

  const sanitized = body?.html ? sanitizeEmailHtml(body.html, showRemoteImages) : null
  const sanitizedHtml = sanitized?.html || null

  const toolBtn = 'flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors'
  const iconBtn = 'p-1.5 text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors'
  const divider = <div className="w-px h-4 bg-[#d0d7de] dark:bg-[#30363d] mx-0.5 flex-shrink-0" />

  const accountFolders = (currentAccountId ? folders[currentAccountId] : null) || []
  const movableFolders = accountFolders.filter(f => f.path !== currentFolder && f.path !== '__starred__')
  const unsubscribeLink = extractUnsubscribeLink(body?.html, body?.text)

  const isPreviewable = (att: Attachment) => {
    const type = (att.contentType || '').toLowerCase()
    const name = (att.filename || '').toLowerCase()
    return type.startsWith('image/') || type === 'application/pdf' || name.endsWith('.pdf')
  }

  // Attachment bytes are no longer inlined in the message payload; each one is
  // streamed from its own endpoint, so preview and download are plain URLs.
  const attachmentSrc = (index: number, inline: boolean) =>
    emailsApi.attachmentUrl(selectedEmail.accountId, selectedEmail.id, index, {
      folder: selectedEmail.folder,
      inline,
    })

  const downloadAttachment = (att: Attachment, index: number) => {
    const link = document.createElement('a')
    link.href = attachmentSrc(index, false)
    link.download = att.filename || `attachment-${index}`
    // The server sets Content-Disposition: attachment, so the browser saves it
    // without ever holding the bytes in JS memory.
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  // "Summarize" still needs the bytes in hand — fetch just that one file.
  const summarizeAttachment = async (att: Attachment, index: number) => {
    setAttachmentSummaries(s => ({ ...s, [index]: 'Summarizing…' }))
    try {
      const buffer = await emailsApi.fetchAttachment(selectedEmail.accountId, selectedEmail.id, index, selectedEmail.folder)
      let binary = ''
      const bytes = new Uint8Array(buffer)
      // Chunked to stay under the argument limit of String.fromCharCode.
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      const { summary } = await aiApi.summarizeAttachment({
        filename: att.filename,
        contentType: att.contentType,
        content: btoa(binary),
      })
      setAttachmentSummaries(s => ({ ...s, [index]: summary }))
    } catch {
      setAttachmentSummaries(s => ({ ...s, [index]: 'Unable to summarize this attachment.' }))
    }
  }

  // Forwarding has to carry the files with it, so they are pulled down once and
  // handed to the compose window as inline data.
  const collectAttachmentsForForward = async (): Promise<DraftAttachment[]> => {
    const list = body?.attachments || []
    const out: DraftAttachment[] = []
    for (const [index, att] of list.entries()) {
      try {
        const buffer = await emailsApi.fetchAttachment(selectedEmail.accountId, selectedEmail.id, index, selectedEmail.folder)
        const bytes = new Uint8Array(buffer)
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        out.push({
          filename: att.filename,
          contentType: att.contentType || 'application/octet-stream',
          content: btoa(binary),
          size: bytes.length,
        })
      } catch {
        // Skip a file we can't retrieve rather than blocking the forward.
      }
    }
    return out
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#0d1117]">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-3 py-2 border-b border-[#d0d7de] dark:border-[#30363d] bg-[#f6f8fa] dark:bg-[#161b22]">
        {/* Reply group */}
        <button onClick={handleReply} className={toolBtn} aria-label="Reply to email" title="Reply (r)">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none"><path d="M5 3L1 6.5M1 6.5L5 10M1 6.5h8a3 3 0 010 6h-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Reply
        </button>
        <button
          onClick={handleReplyAll}
          className={toolBtn}
          aria-label="Reply to all recipients"
        >
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none"><path d="M4 3L0 6.5M0 6.5L4 10M0 6.5h7M8 3L12 6.5M12 6.5L8 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Reply All
        </button>
        <button onClick={handleForward} className={toolBtn} aria-label="Forward email" title="Forward (f)">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none"><path d="M8 3l4 3.5M12 6.5L8 10M12 6.5H4a3 3 0 000 6h1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Forward
        </button>
        <button onClick={handleSummarizeThread} className={toolBtn} disabled={summaryLoading} aria-label="Summarize email thread">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 3h10M3 7h7M3 11h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
          {summaryLoading ? 'Summarizing…' : 'Summarize'}
        </button>
        <button onClick={handleExtractActions} className={toolBtn} disabled={actionsLoading} title="Find tasks and dates">{actionsLoading ? 'Finding…' : 'Actions'}</button>

        {unsubscribeLink && (
          <button
            onClick={() => window.open(unsubscribeLink, '_blank')}
            className={toolBtn}
            title="Unsubscribe"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l5 5-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Unsubscribe
          </button>
        )}

        {divider}

        {/* Actions group */}
        <button
          onClick={handleStar}
          title={selectedEmail.starred ? 'Unstar' : 'Star'}
          className={`${iconBtn} ${selectedEmail.starred ? '!text-[#f59e0b]' : ''}`}
        >
          <StarIcon filled={selectedEmail.starred} />
        </button>

        <button onClick={handleMarkUnread} title="Mark as unread (u)" aria-label="Mark as unread" className={iconBtn}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4a1 1 0 011-1h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M2 4l6 5 6-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="13" cy="4" r="2.5" fill="#f59e0b"/>
          </svg>
        </button>

        {currentFolder === '__snoozed__' ? (
          <button onClick={handleUnsnooze} title="Un-snooze" aria-label="Un-snooze email" className={iconBtn}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.3"/><path d="M6 7h4l-4 3.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        ) : (
          <div className="relative">
            <button onClick={() => { setShowSnoozeMenu(v => !v); setShowMoveMenu(false) }} title="Snooze" aria-label="Snooze email" className={iconBtn}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.3"/><path d="M6 7h4l-4 3.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 1.5L2.5 3.5M11 1.5l2.5 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            </button>
            {showSnoozeMenu && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-[#161b22] border border-[#d0d7de] dark:border-[#30363d] rounded-xl shadow-2xl z-20 py-1.5 overflow-hidden">
                <div className="px-3 py-1 text-[9px] font-bold text-[#818b98] dark:text-[#484f58] uppercase tracking-widest">Snooze until</div>
                {snoozeOptions().map(opt => (
                  <button
                    key={opt.label}
                    onClick={() => handleSnooze(opt.until)}
                    className="w-full text-left px-3 py-2 text-xs text-[#24292f] dark:text-[#c9d1d9] hover:bg-[#f6f8fa] dark:hover:bg-[#21262d] transition-colors flex items-center justify-between gap-2"
                  >
                    <span>{opt.label}</span>
                    <span className="text-[10px] text-[#818b98] dark:text-[#484f58]">{opt.until.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {movableFolders.length > 0 && (
          <div className="relative">
            <button onClick={() => { setShowMoveMenu(v => !v); setShowSnoozeMenu(false) }} title="Move to folder" className={iconBtn}>
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

        {/* Archive */}
        <button onClick={handleArchive} className={toolBtn} title="Archive (e)" aria-label="Archive email">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4h12v1H2zM3 5v7a1 1 0 001 1h8a1 1 0 001-1V5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
            <path d="M6 8h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          Archive
        </button>

        {/* Delete */}
        <button onClick={handleDelete} className="p-1.5 text-[#818b98] dark:text-[#484f58] hover:text-[#cf222e] dark:hover:text-[#f85149] hover:bg-[#fff0ee] dark:hover:bg-[#f85149]/10 rounded-md transition-colors" title="Delete (d)" aria-label="Delete email">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6L12 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <button onClick={handleSpam} className="p-1.5 text-[#818b98] hover:text-[#cf222e] rounded-md" title="Report spam">Spam</button>
        <button onClick={handleBlock} className="p-1.5 text-[#818b98] hover:text-[#cf222e] rounded-md" title="Block sender">Block</button>
      </div>

      {/* Header */}
      <div className="px-6 py-5 border-b border-[#d0d7de] dark:border-[#30363d]">
        <h1 className="text-lg font-semibold text-[#1f2328] dark:text-[#e6edf3] mb-4 leading-snug">
          {selectedEmail.subject || '(no subject)'}
        </h1>
        <div className="flex items-start gap-3">
          <Avatar from={selectedEmail.from} size={36} />
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
      <div className="flex-1 overflow-y-auto px-6 py-5" onClick={() => { setShowMoveMenu(false); setShowSnoozeMenu(false) }}>
        {sanitized?.blocked ? (
          <div className="mb-4 flex items-center justify-between rounded-md bg-[#fff8ec] dark:bg-[#1c2128] px-3 py-2 text-xs text-[#656d76] dark:text-[#8b949e]">
            <span>{sanitized.blocked} remote image{sanitized.blocked === 1 ? '' : 's'} blocked for privacy.</span>
            <button onClick={() => setShowRemoteImages(true)} className="font-semibold text-[#0969da]">Show images</button>
          </div>
        ) : null}
        {conversationBodies.length > 0 && (
          <div className="mb-5 space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wide text-[#818b98]">Earlier in this conversation</div>
            {conversationBodies.map(({ email, body: prior }) => (
              <details key={email!.id} className="rounded-lg border border-[#d0d7de] dark:border-[#30363d] bg-[#f6f8fa] dark:bg-[#161b22]">
                <summary className="cursor-pointer px-3 py-2 text-xs"><strong>{prior.from}</strong><span className="float-right text-[#818b98]">{formatFullDate(prior.date)}</span></summary>
                <div className="border-t border-[#d0d7de] dark:border-[#30363d] px-3 py-3 text-xs whitespace-pre-wrap">{prior.text || stripHtml(prior.html || '')}</div>
              </details>
            ))}
          </div>
        )}
        {actions.length > 0 && (
          <div className="mb-5 rounded-lg border border-[#d0d7de] dark:border-[#30363d] p-3">
            <div className="text-xs font-semibold mb-2">Suggested actions</div>
            {actions.map((a, i) => <div key={i} className="flex items-center gap-2 text-xs py-1"><span className="flex-1">{a.kind === 'calendar' ? '📅' : '✓'} {a.title}{a.date ? ` — ${a.date}` : ''}</span><button onClick={() => {
              if (a.kind === 'calendar') {
                const start = new Date(a.date || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
                const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART:${start}\r\nSUMMARY:${a.title.replace(/\n/g, ' ')}\r\nDESCRIPTION:${(a.details || '').replace(/\n/g, ' ')}\r\nEND:VEVENT\r\nEND:VCALENDAR`
                const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })); const link = document.createElement('a'); link.href = url; link.download = 'hermes-event.ics'; link.click(); URL.revokeObjectURL(url)
              } else {
                handleReminder(a.date)
              }
            }} className="text-[#0969da]">{a.kind === 'calendar' ? 'Add to calendar' : 'Create reminder'}</button></div>)}
          </div>
        )}
        {threadSummary && (
          <div className="mb-5 border border-[#d0d7de] dark:border-[#30363d] bg-[#f6f8fa] dark:bg-[#161b22] rounded-lg p-4">
            <div className="text-xs font-semibold text-[#656d76] dark:text-[#8b949e] mb-2">AI Thread Summary</div>
            <div className="text-sm text-[#24292f] dark:text-[#c9d1d9] mb-3 leading-relaxed">{threadSummary.summary}</div>
            {threadSummary.keyPoints?.length > 0 && (
              <div className="mb-2">
                <div className="text-[11px] font-semibold text-[#656d76] dark:text-[#8b949e] mb-1">Key points</div>
                <ul className="list-disc pl-4 text-[11.5px] text-[#24292f] dark:text-[#c9d1d9]">
                  {threadSummary.keyPoints.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>
            )}
            {threadSummary.actionItems?.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold text-[#656d76] dark:text-[#8b949e] mb-1">Action items</div>
                <ul className="list-disc pl-4 text-[11.5px] text-[#24292f] dark:text-[#c9d1d9]">
                  {threadSummary.actionItems.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
        {summaryError && (
          <div className="mb-5 text-xs text-[#cf222e] dark:text-[#f85149]">{summaryError}</div>
        )}

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
                    {isPreviewable(att) && (
                      <button
                        title="Preview"
                        onClick={() => setPreviewOpen(s => ({ ...s, [i]: !s[i] }))}
                        className="text-[#0969da] hover:text-[#1f6feb] transition-colors text-[11px]"
                      >
                        {previewOpen[i] ? 'Hide' : 'Preview'}
                      </button>
                    )}
                    <button
                      title="Download"
                      onClick={() => downloadAttachment(att, i)}
                      className="text-[#f59e0b] hover:text-[#d97706] transition-colors"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v7M3 5l3 3 3-3M1 10h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                    {(att.contentType === 'application/pdf' || att.contentType?.startsWith('text/')) && (
                      <button onClick={() => summarizeAttachment(att, i)} className="text-[#7c3aed] text-[11px]">Summarize</button>
                    )}
                  </div>
                  {attachmentSummaries[i] && <div className="rounded-md bg-[#f6f8fa] dark:bg-[#161b22] p-3 text-xs whitespace-pre-wrap">{attachmentSummaries[i]}</div>}
                  {previewOpen[i] && isPreviewable(att) && (
                    <div className="border border-[#d0d7de] dark:border-[#30363d] rounded-md overflow-hidden bg-white dark:bg-[#0d1117] w-full">
                      {att.contentType?.toLowerCase().startsWith('image/') ? (
                        <img src={attachmentSrc(i, true)} alt={att.filename} className="w-full h-auto max-h-[80vh] object-contain" />
                      ) : (
                        <iframe title={att.filename} src={attachmentSrc(i, true)} className="w-full h-[80vh]" />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {smartReplies.length > 0 && (
          <div className="mt-6 border-t border-[#d0d7de] dark:border-[#30363d] pt-4">
            <div className="text-[10px] font-bold uppercase tracking-wide text-[#818b98] mb-2">Smart reply</div>
            <div className="flex flex-wrap gap-2">{smartReplies.map(reply => <button key={reply} onClick={() => handleSmartReply(reply)} className="rounded-full border border-[#7c3aed]/50 px-3 py-1.5 text-xs text-[#7c3aed] hover:bg-[#7c3aed]/10">{reply}</button>)}</div>
          </div>
        )}
      </div>
    </div>
  )
}
