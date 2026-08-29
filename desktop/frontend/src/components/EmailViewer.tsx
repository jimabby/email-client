import { useEffect, useMemo, useRef, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { useEmailStore } from '../store/emailStore'
import { aiApi, emailsApi } from '../api/client'
import { Avatar, bareAddress } from './Avatar'
import { readJson, writeJson } from '../lib/storage'
import {
  sanitizeEmailHtml, findUnsubscribeUrl, htmlToText, escapeHtml, totalBlocked,
} from '../lib/emailHtml'
import { ReaderFrame } from './ReaderFrame'
import { InviteCard } from './InviteCard'
import { SenderBadge } from './SenderBadge'
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

const stripHtml = htmlToText

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
  <svg width="15" height="15" viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'} className="text-accent">
    <path d="M8 1l1.9 3.8 4.2.6-3 3 .7 4.2L8 10.5l-3.8 2.1.7-4.2-3-3 4.2-.6L8 1z"
      stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
  </svg>
)

/** One row of the reader's overflow menu. */
function MenuItem({ onClick, label, icon, danger, disabled }: {
  onClick: () => void
  label: string
  icon: React.ReactNode
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-left transition-colors
                  disabled:opacity-50 disabled:cursor-default
        ${danger ? 'text-danger hover:bg-danger/10' : 'text-ink hover:bg-ink/6'}`}
    >
      <span className={`flex-shrink-0 ${danger ? '' : 'text-ink-3'}`}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  )
}

export function EmailViewer() {
  const {
    selectedEmail, selectedEmailBody, isLoadingBody,
    openCompose, removeEmail, showNotification,
    toggleStarLocal, markEmailUnread, setSelectedEmail,
    folders, currentAccountId, currentFolder, emails, accounts,
    snoozeEmailLocal, unsnoozeLocal, getArchiveFolder,
  } = useEmailStore()

  const [showMoveMenu, setShowMoveMenu] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
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
    setShowMoreMenu(false)
    setShowMoveMenu(false)
    setShowSnoozeMenu(false)
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
      <div className="flex flex-col items-center justify-center h-full text-center p-8 select-none">
        <div className="w-24 h-24 rounded-[26px] bg-accent/12 border border-accent/20 flex items-center justify-center mb-6 shadow-[0_8px_32px_-12px_rgb(var(--accent)/0.5)]">
          <svg width="46" height="31" viewBox="0 0 60 40" fill="none">
            <path d="M16,13 C11,8 4,9 2,15" stroke="currentColor" className="text-accent" strokeWidth="2.5" strokeLinecap="round"/>
            <path d="M16,19 C11,14 4,15 2,20" stroke="currentColor" className="text-accent" strokeWidth="1.8" strokeLinecap="round" strokeOpacity="0.6"/>
            <path d="M44,13 C49,8 56,9 58,15" stroke="currentColor" className="text-accent" strokeWidth="2.5" strokeLinecap="round"/>
            <path d="M44,19 C49,14 56,15 58,20" stroke="currentColor" className="text-accent" strokeWidth="1.8" strokeLinecap="round" strokeOpacity="0.6"/>
            <rect x="15" y="8" width="30" height="24" rx="4" fill="url(#emptyGold)"/>
            <path d="M15,8 L30,22 L45,8" fill="none" stroke="#7c4a06" strokeWidth="1.3" strokeLinejoin="round" strokeOpacity="0.5"/>
            <defs>
              <linearGradient id="emptyGold" x1="15" y1="8" x2="45" y2="32" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#fbbf24"/>
                <stop offset="100%" stopColor="#d97706"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
        <h3 className="text-[17px] font-semibold text-ink mb-2 tracking-[-0.015em]">No message selected</h3>
        <p className="text-ink-3 text-[13px] leading-relaxed max-w-[220px]">Pick an email from the list, or press <kbd className="px-1.5 py-0.5 mx-0.5 rounded-md bg-ink/8 text-ink-2 text-[11px]">Ctrl&nbsp;N</kbd> to write one</p>
      </div>
    )
  }

  if (isLoadingBody) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-7 py-6 border-b border-line/40">
          <div className="skeleton h-5 w-3/4 mb-5" />
          <div className="flex items-center gap-3">
            <div className="skeleton w-9 h-9 !rounded-full flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="skeleton h-3 w-1/2" />
              <div className="skeleton h-3 w-1/3" />
            </div>
          </div>
        </div>
        <div className="px-7 py-6 space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="skeleton h-3" style={{ width: `${92 - (i % 3) * 14}%`, opacity: 1 - i * 0.1 }} />
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

  // Gmail and Outlook keep a message's id stable through the bin, so a delete
  // there can be taken back. IMAP assigns a new UID on the way to Trash, which
  // leaves nothing to address — so those accounts keep the confirmation
  // prompt instead of being offered an undo that could not work.
  const canUndoDelete = (accountType?: string) => accountType !== 'imap'

  const handleDelete = async () => {
    if (!selectedEmail) return
    const account = accounts.find(a => a.id === selectedEmail.accountId)
    const undoable = canUndoDelete(account?.type)
    if (!undoable && !window.confirm('Delete this email?')) return

    const { id, accountId, folder } = selectedEmail
    try {
      await emailsApi.delete(accountId, id, folder)
      removeEmail(id)
      if (!undoable) {
        showNotification('success', 'Email deleted')
        return
      }
      showNotification('success', 'Email deleted', {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await emailsApi.untrash(accountId, id, folder || 'INBOX')
              showNotification('success', 'Delete undone')
              window.dispatchEvent(new CustomEvent('hermes:refresh-list'))
            } catch {
              showNotification('error', 'Could not restore the message')
            }
          },
        },
        timeoutMs: 8000,
      })
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
    const { id, accountId, folder } = selectedEmail
    const archive = getArchiveFolder(accountId)
    const origin = folder || 'INBOX'

    try {
      await emailsApi.move(accountId, id, archive, origin)
      removeEmail(id)
      // An archive is a folder move, and a move reverses cleanly on every
      // provider — so this undo works everywhere, unlike the one on delete.
      showNotification('success', 'Archived', {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await emailsApi.move(accountId, id, origin, archive)
              showNotification('success', 'Moved back to ' + origin)
              window.dispatchEvent(new CustomEvent('hermes:refresh-list'))
            } catch {
              showNotification('error', 'Could not move the message back')
            }
          },
        },
        timeoutMs: 8000,
      })
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

  const toolBtn = 'btn-ghost flex items-center gap-1.5 px-2.5 h-8 text-[12.5px] font-medium disabled:opacity-50'
  const iconBtn = 'btn-ghost w-8 h-8 flex items-center justify-center !text-ink-3 hover:!text-ink'
  const divider = <div className="w-px h-4 bg-line/70 mx-1 flex-shrink-0" />

  const accountFolders = (currentAccountId ? folders[currentAccountId] : null) || []
  const movableFolders = accountFolders.filter(f => f.path !== currentFolder && f.path !== '__starred__')
  const unsubscribeLink = findUnsubscribeUrl(body?.html, body?.text, body?.listUnsubscribe)

  // The reader frame is a separate document, so it cannot inherit the app's
  // CSS variables — it has to be told which palette to paint.
  const readerTheme: 'light' | 'dark' =
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
      ? 'light'
      : 'dark'

  // Tracking pixels are gone for good; remote images are merely held back. The
  // notice has to say which, because only one of them "Show images" restores.
  const blockedSummary = (() => {
    if (!sanitized) return ''
    const { images, pixels } = sanitized.blocked
    const parts: string[] = []
    if (pixels) parts.push(`${pixels} tracking pixel${pixels === 1 ? '' : 's'} removed`)
    if (images) parts.push(`${images} remote image${images === 1 ? '' : 's'} blocked`)
    if (!parts.length) return 'Some remote content was blocked for privacy.'
    return `${parts.join(' · ')} for privacy.`
  })()

  // The server will only ever serve these types inline; everything else comes
  // back as a download, so offering a preview for it would just be a broken
  // button. Note this keys on the declared type and never on the filename —
  // an attachment called "invoice.pdf" that declares text/html is not a PDF.
  const PREVIEWABLE_TYPES = new Set([
    'application/pdf', 'text/plain',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
  ])
  const attachmentType = (att: Attachment) =>
    (att.contentType || '').toLowerCase().split(';')[0].trim()
  const isPreviewable = (att: Attachment) => PREVIEWABLE_TYPES.has(attachmentType(att))
  const isImage = (att: Attachment) => attachmentType(att).startsWith('image/')

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
    <div className="flex flex-col h-full">
      {/* Toolbar
          Reply / Reply All / Forward earn their labels — they are what this
          pane is for. Everything rare or destructive lives behind "More", so a
          narrow window never has to wrap thirteen controls onto two rows. */}
      <div className="flex items-center gap-0.5 px-2.5 min-h-[52px] py-2 border-b border-line/40">
        <button onClick={handleReply} className={toolBtn} aria-label="Reply to email" title="Reply (r)">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none"><path d="M5 3L1 6.5M1 6.5L5 10M1 6.5h8a3 3 0 010 6h-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Reply
        </button>
        <button onClick={handleReplyAll} className={toolBtn} aria-label="Reply to all recipients" title="Reply all">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none"><path d="M4 3L0 6.5M0 6.5L4 10M0 6.5h7M8 3L12 6.5M12 6.5L8 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Reply All
        </button>
        <button onClick={handleForward} className={toolBtn} aria-label="Forward email" title="Forward (f)">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none"><path d="M8 3l4 3.5M12 6.5L8 10M12 6.5H4a3 3 0 000 6h1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Forward
        </button>

        {divider}

        <button
          onClick={handleStar}
          title={selectedEmail.starred ? 'Unstar' : 'Star (s)'}
          aria-label={selectedEmail.starred ? 'Unstar email' : 'Star email'}
          className={`${iconBtn} ${selectedEmail.starred ? '!text-accent' : ''}`}
        >
          <StarIcon filled={selectedEmail.starred} />
        </button>

        {currentFolder === '__snoozed__' ? (
          <button onClick={handleUnsnooze} title="Un-snooze" aria-label="Un-snooze email" className={iconBtn}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.3"/><path d="M6 7h4l-4 3.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        ) : (
          <div className="relative">
            <button onClick={() => { setShowSnoozeMenu(v => !v); setShowMoveMenu(false); setShowMoreMenu(false) }} title="Snooze" aria-label="Snooze email" className={iconBtn}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.3"/><path d="M6 7h4l-4 3.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 1.5L2.5 3.5M11 1.5l2.5 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            </button>
            {showSnoozeMenu && (
              <div className="absolute right-0 top-full mt-1.5 w-48 glass-elevated rounded-xl z-20 py-1.5 overflow-hidden animate-pop">
                <div className="px-3 py-1 text-[10px] font-semibold text-ink-3 uppercase tracking-[0.08em]">Snooze until</div>
                {snoozeOptions().map(opt => (
                  <button
                    key={opt.label}
                    onClick={() => handleSnooze(opt.until)}
                    className="w-full text-left px-3 py-2 text-[13px] text-ink hover:bg-ink/6 transition-colors flex items-center justify-between gap-2"
                  >
                    <span>{opt.label}</span>
                    <span className="text-[11px] text-ink-3 tabular-nums">{opt.until.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {movableFolders.length > 0 && (
          <div className="relative">
            <button onClick={() => { setShowMoveMenu(v => !v); setShowSnoozeMenu(false); setShowMoreMenu(false) }} title="Move to folder" aria-label="Move to folder" className={iconBtn}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M1 4a1 1 0 011-1h4l1.5 2H14a1 1 0 011 1v6a1 1 0 01-1 1H2a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                <path d="M8 8v4M6 10l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {showMoveMenu && (
              <div className="absolute right-0 top-full mt-1.5 w-48 glass-elevated rounded-xl z-20 py-1.5 overflow-hidden animate-pop max-h-72 overflow-y-auto">
                <div className="px-3 py-1 text-[10px] font-semibold text-ink-3 uppercase tracking-[0.08em]">Move to</div>
                {movableFolders.map(f => (
                  <button
                    key={f.path}
                    onClick={() => handleMove(f.path)}
                    className="w-full text-left px-3 py-2 text-[13px] text-ink hover:bg-ink/6 transition-colors"
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {divider}

        <button onClick={handleArchive} className={toolBtn} title="Archive (e)" aria-label="Archive email">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4h12v1H2zM3 5v7a1 1 0 001 1h8a1 1 0 001-1V5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
            <path d="M6 8h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          Archive
        </button>

        <button
          onClick={handleDelete}
          className={`${iconBtn} hover:!text-danger hover:!bg-danger/10`}
          title="Delete (d)"
          aria-label="Delete email"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6L12 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>

        <div className="flex-1" />

        {/* Overflow */}
        <div className="relative">
          <button
            onClick={() => { setShowMoreMenu(v => !v); setShowMoveMenu(false); setShowSnoozeMenu(false) }}
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={showMoreMenu}
            className={`${iconBtn} ${showMoreMenu ? '!bg-ink/10 !text-ink' : ''}`}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <circle cx="3" cy="8" r="1.35" fill="currentColor"/>
              <circle cx="8" cy="8" r="1.35" fill="currentColor"/>
              <circle cx="13" cy="8" r="1.35" fill="currentColor"/>
            </svg>
          </button>
          {showMoreMenu && (
            <div role="menu" className="absolute right-0 top-full mt-1.5 w-56 glass-elevated rounded-xl z-30 py-1.5 overflow-hidden animate-pop">
              <MenuItem
                onClick={() => { setShowMoreMenu(false); handleSummarizeThread() }}
                disabled={summaryLoading}
                label={summaryLoading ? 'Summarising…' : 'Summarise thread'}
                icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 3h10M3 7h7M3 11h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>}
              />
              <MenuItem
                onClick={() => { setShowMoreMenu(false); handleExtractActions() }}
                disabled={actionsLoading}
                label={actionsLoading ? 'Finding…' : 'Find tasks & dates'}
                icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              />
              <MenuItem
                onClick={() => { setShowMoreMenu(false); handleMarkUnread() }}
                label="Mark as unread"
                icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4a1 1 0 011-1h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3"/><path d="M2 4l6 5 6-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              />
              {unsubscribeLink && (
                <MenuItem
                  onClick={() => { setShowMoreMenu(false); window.open(unsubscribeLink, '_blank', 'noopener,noreferrer') }}
                  label="Unsubscribe"
                  icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l5 5-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                />
              )}

              <div className="my-1.5 h-px bg-line/50" role="separator" />

              <MenuItem
                onClick={() => { setShowMoreMenu(false); handleSpam() }}
                label="Report spam"
                danger
                icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/><path d="M8 5v4M8 11v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>}
              />
              <MenuItem
                onClick={() => { setShowMoreMenu(false); handleBlock() }}
                label="Block sender"
                danger
                icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/><path d="M3.8 3.8l8.4 8.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>}
              />
            </div>
          )}
        </div>
      </div>
      {/* Header */}
      <div className="px-7 pt-6 pb-5 border-b border-line/40">
        <h1 className="text-[21px] font-semibold text-ink mb-5 leading-[1.25] tracking-[-0.02em]">
          {selectedEmail.subject || '(no subject)'}
        </h1>
        <div className="flex items-start gap-3">
          <Avatar from={selectedEmail.from} size={36} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-semibold text-ink text-[14px] truncate tracking-[-0.01em]">{selectedEmail.from}</span>
                <SenderBadge authentication={body?.authentication} />
              </div>
              <span className="text-[12px] text-ink-3 flex-shrink-0 tabular-nums">
                {body?.date ? formatFullDate(body.date) : formatFullDate(selectedEmail.date)}
              </span>
            </div>
            {body?.to && <div className="text-xs text-ink-2 mt-0.5"><span className="text-ink-3 ">To: </span>{body.to}</div>}
            {body?.cc && <div className="text-xs text-ink-2 "><span className="text-ink-3 ">Cc: </span>{body.cc}</div>}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-7 py-6" onClick={() => { setShowMoveMenu(false); setShowSnoozeMenu(false); setShowMoreMenu(false) }}>
        {sanitized && totalBlocked(sanitized.blocked) ? (
          <div className="mb-5 flex items-center justify-between gap-3 rounded-xl bg-accent/12 px-3.5 py-2.5 text-[12.5px] text-ink-2">
            <span>{blockedSummary}</span>
            {sanitized && sanitized.blocked.images > 0 && (
              <button onClick={() => setShowRemoteImages(true)} className="font-semibold text-info hover:underline flex-shrink-0">Show images</button>
            )}
          </div>
        ) : null}
        {conversationBodies.length > 0 && (
          <div className="mb-5 space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-3">Earlier in this conversation</div>
            {conversationBodies.map(({ email, body: prior }) => (
              <details key={email!.id} className="rounded-xl border border-line/50 bg-ink/4 overflow-hidden">
                <summary className="cursor-pointer px-3.5 py-2.5 text-[12.5px] hover:bg-ink/4 transition-colors"><strong>{prior.from}</strong><span className="float-right text-ink-3">{formatFullDate(prior.date)}</span></summary>
                <div className="border-t border-line/50 px-3.5 py-3 text-[12.5px] whitespace-pre-wrap leading-relaxed text-ink-2">{prior.text || stripHtml(prior.html || '')}</div>
              </details>
            ))}
          </div>
        )}
        {actions.length > 0 && (
          <div className="mb-5 rounded-xl border border-line/50 bg-ink/4 p-3.5">
            <div className="text-[12.5px] font-semibold mb-2">Suggested actions</div>
            {actions.map((a, i) => <div key={i} className="flex items-center gap-2 text-xs py-1"><span className="flex-1">{a.kind === 'calendar' ? '📅' : '✓'} {a.title}{a.date ? ` — ${a.date}` : ''}</span><button onClick={() => {
              if (a.kind === 'calendar') {
                const start = new Date(a.date || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
                const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART:${start}\r\nSUMMARY:${a.title.replace(/\n/g, ' ')}\r\nDESCRIPTION:${(a.details || '').replace(/\n/g, ' ')}\r\nEND:VEVENT\r\nEND:VCALENDAR`
                const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })); const link = document.createElement('a'); link.href = url; link.download = 'hermes-event.ics'; link.click(); URL.revokeObjectURL(url)
              } else {
                handleReminder(a.date)
              }
            }} className="text-info">{a.kind === 'calendar' ? 'Add to calendar' : 'Create reminder'}</button></div>)}
          </div>
        )}
        {threadSummary && (
          <div className="mb-5 rounded-xl border border-ai/25 bg-ai/8 p-4">
            <div className="text-[11px] font-semibold text-ai uppercase tracking-[0.07em] mb-2">AI thread summary</div>
            <div className="text-sm text-ink mb-3 leading-relaxed">{threadSummary.summary}</div>
            {threadSummary.keyPoints?.length > 0 && (
              <div className="mb-2">
                <div className="text-[11px] font-semibold text-ink-2 mb-1">Key points</div>
                <ul className="list-disc pl-4 text-[11.5px] text-ink ">
                  {threadSummary.keyPoints.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>
            )}
            {threadSummary.actionItems?.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold text-ink-2 mb-1">Action items</div>
                <ul className="list-disc pl-4 text-[11.5px] text-ink ">
                  {threadSummary.actionItems.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
        {summaryError && (
          <div className="mb-5 text-xs text-danger ">{summaryError}</div>
        )}

        {body?.calendarInvite && (
          <div className="mb-5">
            <InviteCard invite={body.calendarInvite} email={selectedEmail} />
          </div>
        )}

        {sanitizedHtml ? (
          <ReaderFrame html={sanitizedHtml} theme={readerTheme} />
        ) : body?.text ? (
          <pre className="whitespace-pre-wrap font-sans text-[14px] text-ink leading-[1.65]">{body.text}</pre>
        ) : (
          <p className="text-ink-3 italic text-sm">No content</p>
        )}

        {body?.attachments && body.attachments.length > 0 && (
          <div className="mt-6 border-t border-line pt-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-3 mb-2.5">Attachments ({body.attachments.length})</div>
            <div className="flex flex-wrap gap-2">
              {body.attachments.map((att, i) => (
                <div key={i} className="flex flex-col gap-2 w-full">
                  <div className="flex items-center gap-2.5 bg-ink/4 border border-line/50 rounded-xl px-3.5 py-2.5 text-[12.5px]">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 4L6 8.5a2 2 0 01-3-2.5L8 1a3 3 0 014 4.5L5.5 11A4 4 0 01.5 5.5L6 0" stroke="#f59e0b" strokeWidth="1.2" strokeLinecap="round"/></svg>
                    <span className="text-ink ">{att.filename}</span>
                    <span className="text-ink-3 ">({Math.round(att.size / 1024)}KB)</span>
                    {isPreviewable(att) && (
                      <button
                        title="Preview"
                        onClick={() => setPreviewOpen(s => ({ ...s, [i]: !s[i] }))}
                        className="text-info hover:opacity-70 transition-opacity text-[11px]"
                      >
                        {previewOpen[i] ? 'Hide' : 'Preview'}
                      </button>
                    )}
                    <button
                      title="Download"
                      onClick={() => downloadAttachment(att, i)}
                      className="text-accent hover:text-accent-ink transition-colors"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v7M3 5l3 3 3-3M1 10h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                    {(attachmentType(att) === 'application/pdf' || attachmentType(att).startsWith('text/')) && (
                      <button onClick={() => summarizeAttachment(att, i)} className="text-ai text-[11px]">Summarize</button>
                    )}
                  </div>
                  {attachmentSummaries[i] && <div className="rounded-md bg-surface-2 p-3 text-xs whitespace-pre-wrap">{attachmentSummaries[i]}</div>}
                  {previewOpen[i] && isPreviewable(att) && (
                    <div className="border border-line rounded-md overflow-hidden bg-white w-full">
                      {isImage(att) ? (
                        <img src={attachmentSrc(i, true)} alt={att.filename} className="w-full h-auto max-h-[80vh] object-contain" />
                      ) : (
                        // Sandboxed: an attachment is sender-controlled content
                        // and must never run with this origin's privileges.
                        <iframe
                          title={att.filename}
                          src={attachmentSrc(i, true)}
                          sandbox=""
                          className="w-full h-[80vh]"
                        />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {smartReplies.length > 0 && (
          <div className="mt-6 border-t border-line pt-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-3 mb-2.5">Smart reply</div>
            <div className="flex flex-wrap gap-2">{smartReplies.map(reply => <button key={reply} onClick={() => handleSmartReply(reply)} className="rounded-full border border-ai/40 px-3.5 py-1.5 text-[12.5px] text-ai hover:bg-ai/12 transition-colors active:scale-95">{reply}</button>)}</div>
          </div>
        )}
      </div>
    </div>
  )
}
