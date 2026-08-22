import { useState, useRef, useCallback, useEffect, type ChangeEvent } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { createPortal } from 'react-dom'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { useEmailStore } from '../store/emailStore'
import { emailsApi, streamAiSuggestion, type StreamHandle } from '../api/client'
import type { AiMode, Alias, DraftAttachment, MailTemplate } from '../types/email'

// Providers reject very large messages, and base64 inflates bytes by ~33%.
// Refuse locally with a clear message instead of letting the request die with
// an opaque 413 after the whole payload has been uploaded.
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** A file chosen in this session, or one restored from a draft/forward. */
type PendingAttachment =
  | { kind: 'file'; file: File; name: string; size: number }
  | { kind: 'data'; data: DraftAttachment; name: string; size: number }

const AI_MODES: { value: AiMode; label: string; icon: string; description: string }[] = [
  { value: 'improve', label: 'Improve', icon: '✨', description: 'Make it more professional and clear' },
  { value: 'concise', label: 'Concise', icon: '✂️', description: 'Shorten without losing meaning' },
  { value: 'complete', label: 'Complete', icon: '✍️', description: 'Finish what you started' },
  { value: 'grammar', label: 'Fix Grammar', icon: '🔤', description: 'Fix grammar and spelling' },
  { value: 'formal', label: 'Formal', icon: '👔', description: 'Rewrite in formal tone' },
  { value: 'friendly', label: 'Friendly', icon: '😊', description: 'Make it warm and approachable' },
  { value: 'subject', label: 'Subject Ideas', icon: '💡', description: 'Suggest subject line options' },
  { value: 'reply', label: 'Draft Reply', icon: '↩', description: 'Auto-draft a reply' },
  { value: 'custom', label: 'Custom', icon: '🎯', description: 'Give your own instruction' },
]

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── Contact Autocomplete Field ───────────────────────────────────────────────

function ContactField({
  label, value, onChange, contacts, placeholder
}: {
  label: string
  value: string
  onChange: (v: string) => void
  contacts: string[]
  placeholder?: string
}) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [activeIdx, setActiveIdx] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)

  const handleChange = (v: string) => {
    onChange(v)
    // Only autocomplete the last token (after the last comma)
    const lastToken = v.split(',').pop()?.trim() || ''
    if (lastToken.length >= 1) {
      const needle = lastToken.toLowerCase()
      const filtered = contacts
        .filter(c => c.toLowerCase().includes(needle))
        .sort((a, b) => {
          const aLower = a.toLowerCase()
          const bLower = b.toLowerCase()
          const aPrefix = aLower.startsWith(needle) ? 0 : 1
          const bPrefix = bLower.startsWith(needle) ? 0 : 1
          if (aPrefix !== bPrefix) return aPrefix - bPrefix
          return 0 // keep existing recency order from store
        })
        .slice(0, 6)
      setSuggestions(filtered)
      setActiveIdx(-1)
    } else {
      setSuggestions([])
    }
  }

  const selectSuggestion = (suggestion: string) => {
    const parts = value.split(',')
    parts[parts.length - 1] = ' ' + suggestion
    onChange(parts.join(',').replace(/^,\s*/, '') + ', ')
    setSuggestions([])
    setActiveIdx(-1)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!suggestions.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (activeIdx >= 0) { e.preventDefault(); selectSuggestion(suggestions[activeIdx]) }
      else { setSuggestions([]) }
    } else if (e.key === 'Escape') { setSuggestions([]) }
  }

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setSuggestions([]) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} className="relative flex-1">
      <input
        type="text"
        value={value}
        onChange={e => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="w-full text-sm bg-transparent text-ink placeholder-ink-3 focus:outline-none"
      />
      {suggestions.length > 0 && (
        <div className="absolute left-0 top-full mt-1.5 w-64 glass-elevated rounded-xl z-50 py-1.5 max-h-48 overflow-y-auto animate-pop">
          {suggestions.map((s, i) => (
            <button
              key={s}
              onMouseDown={e => { e.preventDefault(); selectSuggestion(s) }}
              className={`w-full text-left px-3 py-1.5 text-xs truncate transition-colors ${
                i === activeIdx ? 'bg-surface-3 text-ink ' : 'text-ink hover:bg-surface-3 '
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── TipTap Toolbar ───────────────────────────────────────────────────────────

function RichToolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null

  const btn = (active: boolean) =>
    `px-1.5 py-1 rounded text-xs font-semibold transition-colors ${
      active
        ? 'bg-surface-3 text-ink '
        : 'text-ink-3 hover:bg-surface-3 hover:text-ink '
    }`

  const setLink = () => {
    const prev = editor.getAttributes('link').href
    const url = window.prompt('Enter URL', prev || 'https://')
    if (!url) { editor.chain().focus().unsetLink().run(); return }
    editor.chain().focus().setLink({ href: url }).run()
  }

  return (
    <div className="flex items-center gap-0.5 px-3 py-2 border-b border-line/40">
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} className={btn(editor.isActive('bold'))} title="Bold">B</button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} className={`${btn(editor.isActive('italic'))} italic`} title="Italic">I</button>
      <button type="button" onClick={() => editor.chain().focus().toggleUnderline().run()} className={`${btn(editor.isActive('underline'))} underline`} title="Underline">U</button>
      <div className="w-px h-4 bg-line mx-1" />
      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} className={btn(editor.isActive('bulletList'))} title="Bullet list">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="2" cy="3.5" r="1" fill="currentColor"/><line x1="5" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="2" cy="7" r="1" fill="currentColor"/><line x1="5" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="2" cy="10.5" r="1" fill="currentColor"/><line x1="5" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={btn(editor.isActive('orderedList'))} title="Ordered list">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><text x="0" y="5" fontSize="5" fill="currentColor">1.</text><line x1="5" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><text x="0" y="9" fontSize="5" fill="currentColor">2.</text><line x1="5" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><text x="0" y="13" fontSize="5" fill="currentColor">3.</text><line x1="5" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
      </button>
      <div className="w-px h-4 bg-line mx-1" />
      <button type="button" onClick={setLink} className={btn(editor.isActive('link'))} title="Insert link">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M5.5 8.5a3.5 3.5 0 005 0l2-2a3.5 3.5 0 00-5-5L6.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><path d="M8.5 5.5a3.5 3.5 0 00-5 0l-2 2a3.5 3.5 0 005 5l1-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
      </button>
    </div>
  )
}

// ─── Main Compose Modal ───────────────────────────────────────────────────────

export function ComposeModal() {
  const {
    composeData, accounts, closeCompose, showNotification,
    aiProvider, aiConfigured, contacts, addContacts, getSignatureForAccount,
    saveDraft, deleteDraft,
  } = useEmailStore()

  const isReply = !!composeData?.replyTo

  // Stable id for this compose session so repeated saves update one draft.
  const draftIdRef = useRef(
    composeData?.draftId ||
    (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  )

  const [to, setTo] = useState(composeData?.to || '')
  const [cc, setCc] = useState(composeData?.cc || '')
  const [bcc, setBcc] = useState(composeData?.bcc || '')
  const [subject, setSubject] = useState(composeData?.subject || '')
  const [accountId, setAccountId] = useState(composeData?.accountId || accounts[0]?.id || '')
  const [showCcBcc, setShowCcBcc] = useState(!!(composeData?.cc || composeData?.bcc))
  const [isSending, setIsSending] = useState(false)
  // Restored drafts and forwards arrive with their attachment bytes already
  // in hand; newly picked files are read lazily at send time.
  const [attachments, setAttachments] = useState<PendingAttachment[]>(
    (composeData?.attachments || []).map(data => ({ kind: 'data' as const, data, name: data.filename, size: data.size }))
  )
  const [sendAs, setSendAs] = useState(composeData?.sendAs || '')
  const [aliases, setAliasOptions] = useState<Alias[]>([])
  const [undoWindowSec, setUndoWindowSec] = useState(60)
  const [showSchedule, setShowSchedule] = useState(false)
  const [scheduledAt, setScheduledAt] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [isExpanded, setIsExpanded] = useState(false)
  const [showAiPanel, setShowAiPanel] = useState(false)
  const [aiMode, setAiMode] = useState<AiMode>('improve')
  const [customPrompt, setCustomPrompt] = useState('')
  const [aiSuggestion, setAiSuggestion] = useState('')
  const [isAiLoading, setIsAiLoading] = useState(false)
  const [aiDone, setAiDone] = useState(false)
  const [aiError, setAiError] = useState('')
  const [expandedAiHeight, setExpandedAiHeight] = useState(220)
  const [templates, setTemplates] = useState<MailTemplate[]>([])
  const [smartCompletion, setSmartCompletion] = useState('')
  // The tiptap editor's handleKeyDown / onUpdate closures are created once and
  // capture their initial values, so read live state through refs (same reason
  // sendRef exists for Ctrl+Enter).
  const smartCompletionRef = useRef('')
  const subjectRef = useRef('')
  const smartTimerRef = useRef<number | null>(null)
  const smartAbortRef = useRef<StreamHandle | null>(null)
  const abortRef = useRef<StreamHandle | null>(null)
  const resizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  useEffect(() => { emailsApi.getTemplates().then(setTemplates).catch(() => {}) }, [])

  // Send-as identities for whichever account is selected.
  useEffect(() => {
    if (!accountId) { setAliasOptions([]); return }
    let cancelled = false
    emailsApi.getAliases(accountId)
      .then(list => {
        if (cancelled) return
        setAliasOptions(list)
        // Keep an explicit choice; otherwise fall back to a configured default.
        setSendAs(current => {
          if (current && list.some(a => a.email === current)) return current
          return list.find(a => a.isDefault)?.email || ''
        })
      })
      .catch(() => { if (!cancelled) setAliasOptions([]) })
    return () => { cancelled = true }
  }, [accountId])

  // Build initial content: reply body stays as-is; new emails get signature
  const initialHtml = (() => {
    const base = composeData?.body || ''
    const sig = getSignatureForAccount(accountId)
    if (!isReply && sig) {
      return base + `<p></p><p>--<br>${sig.replace(/\n/g, '<br>')}</p>`
    }
    return base
  })()

  const sendRef = useRef<() => void>(() => {})
  const acceptSmartRef = useRef<() => void>(() => {})
  // Baseline for "did the user actually type anything?" — see hasDraftContent.
  const initialTextRef = useRef(
    initialHtml.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
  )

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: 'Write your email…' }),
    ],
    content: initialHtml,
    editorProps: {
      attributes: {
        class: 'flex-1 px-4 py-3 text-sm text-ink leading-relaxed focus:outline-none min-h-[120px]',
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Tab' && smartCompletionRef.current) {
          event.preventDefault()
          acceptSmartRef.current()
          return true
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault()
          sendRef.current()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor: current }) => {
      setSmartCompletion('')
      if (!aiConfigured) return
      if (smartTimerRef.current) window.clearTimeout(smartTimerRef.current)
      const text = current.getText().trim()
      if (text.length < 20) return
      smartTimerRef.current = window.setTimeout(() => {
        // streamAiSuggestion now hands back the handle synchronously, so the
        // previous suggestion is genuinely aborted instead of being left to
        // run to completion in the background on every keystroke pause.
        smartAbortRef.current?.abort()
        let completion = ''
        smartAbortRef.current = streamAiSuggestion(
          { subject: subjectRef.current, body: text, mode: 'complete' },
          chunk => { completion += chunk; setSmartCompletion(completion) },
          () => {}, () => setSmartCompletion('')
        )
      }, 900)
    },
  })

  // Keep refs read by the editor's stable closures in sync with live state.
  useEffect(() => { smartCompletionRef.current = smartCompletion }, [smartCompletion])
  useEffect(() => { subjectRef.current = subject }, [subject])

  // Accept the smart-compose suggestion: append the continuation to the
  // existing content (it's a continuation, not a replacement) so the user's
  // draft, formatting, and signature are preserved.
  const acceptSmartCompletion = () => {
    const completion = smartCompletionRef.current
    if (!completion || !editor) return
    const html = completion
      .split(/\n{2,}/)
      .map(block => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
      .join('')
    editor.chain().focus('end').insertContent(html).run()
    setSmartCompletion('')
  }
  acceptSmartRef.current = acceptSmartCompletion

  useEffect(() => () => { if (smartTimerRef.current) window.clearTimeout(smartTimerRef.current); smartAbortRef.current?.abort() }, [])

  const readFileAsBase64 = (file: File): Promise<DraftAttachment> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1] || ''
        resolve({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          content: base64,
          size: file.size,
        })
      }
      reader.readAsDataURL(file)
    })

  /** Materialise every attachment (files and restored ones) as base64. */
  const resolveAttachments = async (): Promise<DraftAttachment[]> =>
    Promise.all(attachments.map(a => (a.kind === 'data' ? Promise.resolve(a.data) : readFileAsBase64(a.file))))

  const totalAttachmentBytes = attachments.reduce((sum, a) => sum + a.size, 0)
  const overAttachmentLimit = totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || [])
    e.target.value = ''
    if (!picked.length) return

    const additional = picked.reduce((sum, f) => sum + f.size, 0)
    if (totalAttachmentBytes + additional > MAX_TOTAL_ATTACHMENT_BYTES) {
      showNotification('error', `Attachments must total under ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} MB`)
      return
    }
    setAttachments(prev => [
      ...prev,
      ...picked.map(file => ({ kind: 'file' as const, file, name: file.name, size: file.size })),
    ])
  }

  const handleSend = async () => {
    if (!to || !subject) { showNotification('error', 'Please fill in To and Subject fields'); return }
    if (!accountId) { showNotification('error', 'Please select an account'); return }
    if (showSchedule && !scheduledAt) { showNotification('error', 'Please choose a scheduled send time'); return }
    if (overAttachmentLimit) {
      showNotification('error', `Attachments must total under ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} MB`)
      return
    }
    setIsSending(true)
    try {
      const html = editor?.getHTML() || ''
      const text = editor?.getText() || ''
      const attachmentData = attachments.length ? await resolveAttachments() : undefined
      // Reply threading: headers work from any account; the provider-specific
      // bits (Gmail threadId, Outlook reply draft) only apply when sending
      // from the account that owns the original message (its id is prefixed
      // with the account id).
      const r = composeData?.replyTo
      const ownsOriginal = !!r?.id && r.id.startsWith(accountId)
      const sendResult = await emailsApi.send(accountId, {
        to, cc: cc || undefined, bcc: bcc || undefined, subject,
        html, text, attachments: attachmentData,
        sendAt: showSchedule && scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        undoWindowSec: undoWindowSec > 0 ? undoWindowSec : undefined,
        sendAs: sendAs ? { email: sendAs, name: aliases.find(a => a.email === sendAs)?.name } : undefined,
        inReplyTo: r?.messageId || undefined,
        references: r?.references || undefined,
        threadId: ownsOriginal ? r?.threadId || undefined : undefined,
        replyToEmailId: ownsOriginal ? r?.id : undefined,
        replyToFolder: ownsOriginal ? r?.folder : undefined,
      })
      // Save contacts for autocomplete
      const parseAddresses = (s: string) => s.split(',').map(a => a.trim()).filter(Boolean)
      addContacts([...parseAddresses(to), ...parseAddresses(cc), ...parseAddresses(bcc)])

      // Every send is queued now (that is what survives a dropped connection),
      // but a message with no schedule and no undo window goes out within
      // seconds, so calling it "queued" would just be confusing.
      const isDeferred = (showSchedule && !!scheduledAt) || undoWindowSec > 0

      // An undo window gets its own countdown bar rather than a toast: the user
      // needs to see how much time is left, not guess at it.
      const hasUndoWindow = undoWindowSec > 0 && !!sendResult.jobId && !!sendResult.canUndoUntil

      if (hasUndoWindow) {
        useEmailStore.getState().setPendingSend({
          jobId: sendResult.jobId!,
          accountId,
          canUndoUntil: sendResult.canUndoUntil!,
          subject,
          windowSec: undoWindowSec,
        })
      } else if (sendResult.queued && isDeferred) {
        const when = sendResult.sendAt ? new Date(sendResult.sendAt).toLocaleString() : 'soon'
        showNotification('success', `Email scheduled for ${when}`, {
          action: { label: 'Outbox', onClick: () => useEmailStore.getState().setShowOutboxModal(true) },
        })
      } else {
        showNotification('success', 'Email sent!', {
          // The send happens on the server moments from now; if it fails the
          // outbox holds it, so point there rather than claiming success blindly.
          action: { label: 'Outbox', onClick: () => useEmailStore.getState().setShowOutboxModal(true) },
        })
      }
      // Clear any saved draft for this compose (local + server copy).
      const sentRef = useEmailStore.getState().drafts.find(d => d.id === draftIdRef.current)?.serverRef
      deleteDraft(draftIdRef.current)
      if (sentRef) emailsApi.deleteServerDraft(accountId, sentRef).catch(() => {})
      closeCompose()
    } catch (err: unknown) {
      showNotification('error', err instanceof Error ? err.message : 'Failed to send email')
    } finally { setIsSending(false) }
  }
  sendRef.current = handleSend

  // ─── Drafts ──────────────────────────────────────────────────────────────

  // The editor is pre-filled with the signature for new messages, so a
  // never-touched compose window still reports non-empty text. Compare against
  // the content the window opened with instead, or closing a blank compose
  // silently litters the drafts list.
  const hasDraftContent = () => {
    if (to.trim() || cc.trim() || bcc.trim() || subject.trim() || attachments.length) return true
    const current = (editor?.getText() || '').replace(/\s+/g, ' ').trim()
    return !!current && current !== initialTextRef.current
  }

  const existingServerRef = () =>
    useEmailStore.getState().drafts.find(d => d.id === draftIdRef.current)?.serverRef ?? null

  const buildDraft = (serverRef = existingServerRef(), attachmentData?: DraftAttachment[]) => ({
    id: draftIdRef.current,
    accountId,
    to, cc, bcc, subject,
    body: editor?.getHTML() || '',
    savedAt: new Date().toISOString(),
    serverRef,
    // Without this a saved draft came back with its attachments silently gone.
    attachments: attachmentData,
  })

  // Explicit "Save draft": persist locally AND sync to the provider's Drafts
  // folder so it shows up in Gmail/Outlook and on other devices.
  const handleSaveDraft = async () => {
    if (!hasDraftContent()) { closeCompose(); return }
    const prevRef = existingServerRef()
    let attachmentData: DraftAttachment[] | undefined
    try {
      attachmentData = attachments.length ? await resolveAttachments() : undefined
    } catch {
      attachmentData = undefined
    }
    try {
      const { ref } = await emailsApi.saveServerDraft(accountId, {
        to, cc, bcc, subject,
        html: editor?.getHTML() || '', text: editor?.getText() || '',
        attachments: attachmentData,
        replaceRef: prevRef,
      })
      saveDraft(buildDraft(ref, attachmentData))
      showNotification('success', 'Draft saved')
    } catch {
      // Provider sync failed — keep a local copy so work isn't lost.
      saveDraft(buildDraft(prevRef, attachmentData))
      showNotification('error', 'Draft saved locally (sync to mail server failed)')
    }
    closeCompose()
  }

  // Close via the header "X": keep work by auto-saving locally if there's
  // content (no server round-trip, to avoid piling up server drafts).
  const handleClose = async () => {
    if (!hasDraftContent()) { closeCompose(); return }
    let attachmentData: DraftAttachment[] | undefined
    try {
      attachmentData = attachments.length ? await resolveAttachments() : undefined
    } catch {
      attachmentData = undefined
    }
    saveDraft(buildDraft(existingServerRef(), attachmentData))
    closeCompose()
  }

  // Discard (trash): drop the local draft and any server copy, then close.
  const handleDiscard = () => {
    const ref = existingServerRef()
    deleteDraft(draftIdRef.current)
    if (ref) emailsApi.deleteServerDraft(accountId, ref).catch(() => {})
    closeCompose()
  }

  const handleAiSuggest = useCallback(() => {
    if (isAiLoading) { abortRef.current?.abort(); setIsAiLoading(false); return }
    setIsAiLoading(true); setAiDone(false); setAiSuggestion(''); setAiError('')
    const bodyText = editor?.getText() || ''
    const replyTo = composeData?.replyTo
      ? {
          from: composeData.replyTo.from,
          subject: composeData.replyTo.subject,
          body: composeData.replyTo.text
            || composeData.replyTo.html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
            || ''
        }
      : undefined
    // Assigned synchronously, so "Stop" aborts *this* request rather than the
    // previous one.
    abortRef.current = streamAiSuggestion(
      { subject, body: bodyText, mode: aiMode, customPrompt: aiMode === 'custom' ? customPrompt : undefined, replyTo },
      (text) => setAiSuggestion(prev => prev + text),
      () => { setIsAiLoading(false); setAiDone(true) },
      (err) => { setIsAiLoading(false); setAiError(err) }
    )
  }, [subject, editor, aiMode, customPrompt, composeData, isAiLoading])

  const applyAiSuggestion = () => {
    if (aiMode === 'subject') {
      const first = aiSuggestion.split('\n').filter(l => l.trim())[0]?.replace(/^\d+\.\s*/, '').trim()
      if (first) setSubject(first)
    } else {
      // The model's output is plain text — escape it so a stray "<" can't be
      // parsed as markup and mangle (or inject into) the editor content.
      const paragraphs = aiSuggestion
        .split(/\n{2,}/)
        .map(block => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
        .join('')
      editor?.commands.setContent(paragraphs || '<p></p>')
    }
    setAiSuggestion(''); setAiDone(false)
    showNotification('success', 'AI suggestion applied!')
  }

  const handleAiResizeMove = useCallback((e: MouseEvent) => {
    if (!resizeDragRef.current) return
    const delta = resizeDragRef.current.startY - e.clientY
    const next = Math.max(140, Math.min(460, resizeDragRef.current.startHeight + delta))
    setExpandedAiHeight(next)
  }, [])

  const handleAiResizeEnd = useCallback(() => {
    resizeDragRef.current = null
    window.removeEventListener('mousemove', handleAiResizeMove)
    window.removeEventListener('mouseup', handleAiResizeEnd)
  }, [handleAiResizeMove])

  const handleAiResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    resizeDragRef.current = { startY: e.clientY, startHeight: expandedAiHeight }
    window.addEventListener('mousemove', handleAiResizeMove)
    window.addEventListener('mouseup', handleAiResizeEnd)
  }

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleAiResizeMove)
      window.removeEventListener('mouseup', handleAiResizeEnd)
    }
  }, [handleAiResizeEnd, handleAiResizeMove])

  if (!composeData) return null

  const rowCls = 'flex items-center gap-2 px-4 py-2.5 border-b border-line '
  const labelCls = 'text-[11px] text-ink-3 w-12 flex-shrink-0'

  // Shared AI panel content (used in both modes)
  const aiPanelContent = (
    <>
      <div className="p-3 border-b border-line ">
        <p className="text-[10px] text-ink-3 mb-2 uppercase tracking-wide font-semibold">Mode</p>
        <div className="grid grid-cols-3 gap-1">
          {AI_MODES.map(mode => (
            <button
              key={mode.value}
              onClick={() => setAiMode(mode.value)}
              title={mode.description}
              className={`flex flex-col items-center gap-0.5 p-1.5 rounded-md text-[10px] transition-colors border
                ${aiMode === mode.value
                  ? 'bg-ai/12 text-ai border-ai/40'
                  : 'text-ink-2 border-transparent hover:bg-surface-3 hover:text-ink '
                }`}
            >
              <span>{mode.icon}</span>
              <span className="leading-tight text-center">{mode.label}</span>
            </button>
          ))}
        </div>

        {aiMode === 'custom' && (
          <textarea
            value={customPrompt}
            onChange={e => setCustomPrompt(e.target.value)}
            placeholder={`What should ${aiProvider === 'openai' ? 'ChatGPT' : aiProvider === 'gemini' ? 'Gemini' : 'Claude'} do with this email?`}
            className="field mt-2 w-full p-2.5 text-[12.5px] resize-none"
            rows={2}
          />
        )}

        <button
          onClick={handleAiSuggest}
          disabled={aiMode === 'custom' && !customPrompt}
          className={`mt-2 w-full py-2 rounded-md text-xs font-semibold transition-colors
            ${isAiLoading
              ? 'bg-red-50 border border-red-300 text-red-600 hover:bg-red-100 '
              : 'bg-gradient-to-r from-violet-600 to-blue-600 text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
        >
          {isAiLoading ? '⏹ Stop' : `✦ Ask ${aiProvider === 'openai' ? 'ChatGPT' : aiProvider === 'gemini' ? 'Gemini' : 'Claude'}`}
        </button>
      </div>

      <div className={`overflow-y-auto p-3 ${isExpanded ? 'flex-1' : 'flex-1'}`}>
        {isAiLoading && !aiSuggestion && (
          <div className="flex items-center gap-2 text-violet-500 text-xs">
            <span>{aiProvider === 'openai' ? 'ChatGPT' : aiProvider === 'gemini' ? 'Gemini' : 'Claude'} is thinking</span>
            <span className="flex gap-1">
              {[0,1,2].map(i => <span key={i} className="ai-loading-dot w-1 h-1 rounded-full bg-violet-500 inline-block" />)}
            </span>
          </div>
        )}
        {aiSuggestion && (
          <div>
            <div className="text-[10px] text-ink-3 mb-1.5 font-semibold uppercase tracking-wide">
              Suggestion {isAiLoading && <span className="text-violet-500 ml-1 normal-case">streaming…</span>}
            </div>
            <div className="text-[12.5px] text-ink bg-ink/4 border border-line/50 rounded-xl p-3.5 whitespace-pre-wrap leading-relaxed">
              {aiSuggestion}
              {isAiLoading && <span className="animate-pulse text-violet-400">▌</span>}
            </div>
          </div>
        )}
        {aiError && (
          <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-md p-2.5 leading-relaxed">
            <div className="font-semibold mb-0.5">Error</div>
            {aiError}
          </div>
        )}
        {!aiSuggestion && !isAiLoading && !aiError && (
          <div className="text-[11px] text-ink-3 text-center py-4 leading-relaxed">
            Select a mode and click<br/>"{`Ask ${aiProvider === 'openai' ? 'ChatGPT' : aiProvider === 'gemini' ? 'Gemini' : 'Claude'}`}" to get started.
          </div>
        )}
      </div>

      {aiDone && aiSuggestion && (
        <div className="p-3 border-t border-line flex gap-2 flex-shrink-0">
          <button onClick={applyAiSuggestion}
            className="flex-1 bg-accent text-[#201500] py-2 rounded-md text-xs font-bold hover:bg-accent transition-colors">
            ✓ Apply to Email
          </button>
          <button onClick={() => { setAiSuggestion(''); setAiDone(false) }}
            className="px-3 py-2 text-ink-3 hover:text-ink hover:bg-surface-3 rounded-md text-xs transition-colors">
            ✕
          </button>
        </div>
      )}
    </>
  )

  // Shared compose fields + editor
  const composeFields = (
    <div className="flex flex-col flex-1 min-h-0">
      {(accounts.length > 1 || aliases.length > 0) && (
        <div className={rowCls}>
          <span className={labelCls}>From</span>
          <select value={accountId} onChange={e => setAccountId(e.target.value)}
            className="flex-1 text-xs bg-transparent text-ink focus:outline-none">
            {accounts.map(a => <option key={a.id} value={a.id} className="bg-white ">{a.email}</option>)}
          </select>
          {aliases.length > 0 && (
            <select
              value={sendAs}
              onChange={e => setSendAs(e.target.value)}
              title="Send as"
              className="text-xs bg-transparent text-ink-2 focus:outline-none max-w-[45%]"
            >
              <option value="" className="bg-white ">
                {accounts.find(a => a.id === accountId)?.email || 'Default address'}
              </option>
              {aliases.map(alias => (
                <option key={alias.email} value={alias.email} className="bg-white ">
                  {alias.name ? `${alias.name} <${alias.email}>` : alias.email}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className={rowCls}>
        <span className={labelCls}>To</span>
        <ContactField value={to} onChange={setTo} contacts={contacts} placeholder="recipient@example.com" label="To" />
        <button onClick={() => setShowCcBcc(!showCcBcc)} className="text-[10px] text-ink-3 hover:text-accent transition-colors flex-shrink-0">Cc Bcc</button>
      </div>
      {showCcBcc && (
        <>
          <div className={rowCls}>
            <span className={labelCls}>Cc</span>
            <ContactField value={cc} onChange={setCc} contacts={contacts} placeholder="cc@example.com" label="Cc" />
          </div>
          <div className={rowCls}>
            <span className={labelCls}>Bcc</span>
            <ContactField value={bcc} onChange={setBcc} contacts={contacts} placeholder="bcc@example.com" label="Bcc" />
          </div>
        </>
      )}
      <div className={rowCls}>
        <span className={labelCls}>Subject</span>
        <input type="text" value={subject} onChange={e => setSubject(e.target.value)} placeholder="Email subject"
          className="flex-1 text-sm font-medium bg-transparent text-ink placeholder-ink-3 focus:outline-none" />
      </div>
      {showSchedule && (
        <div className={rowCls}>
          <span className={labelCls}>Send at</span>
          <input
            type="datetime-local"
            value={scheduledAt}
            min={new Date(Date.now() + 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)}
            onChange={e => setScheduledAt(e.target.value)}
            className="flex-1 text-xs bg-transparent text-ink focus:outline-none"
          />
        </div>
      )}
      {composeData.replyTo && (
        <div className="px-4 py-2 border-b border-line bg-surface-2 ">
          <div className="text-[10px] text-ink-3 ">
            Replying to <span className="text-ink-2 ">{composeData.replyTo.from}</span>
          </div>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="px-4 py-2 border-b border-line ">
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((f, i) => (
              <div key={i} className="flex items-center gap-1 bg-surface-3 rounded px-2 py-1 text-[11px] text-ink ">
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M10 4L6 8.5a2 2 0 01-3-2.5L8 1a3 3 0 014 4.5L5.5 11A4 4 0 01.5 5.5L6 0" stroke="#f59e0b" strokeWidth="1.2" strokeLinecap="round"/></svg>
                <span className="max-w-[120px] truncate">{f.name}</span>
                <span className="text-ink-3 ">({Math.round(f.size / 1024)}KB)</span>
                <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} className="ml-0.5 text-ink-3 hover:text-danger ">×</button>
              </div>
            ))}
          </div>
          <div className={`mt-1 text-[10px] ${overAttachmentLimit ? 'text-danger ' : 'text-ink-3 '}`}>
            {Math.round(totalAttachmentBytes / 1024)} KB of {Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} MB
            {overAttachmentLimit && ' — too large to send'}
          </div>
        </div>
      )}
      <RichToolbar editor={editor} />
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} className="h-full" />
      </div>
      {smartCompletion && smartCompletion !== editor?.getText() && (
        <button onClick={acceptSmartCompletion} className="mx-4 mb-2 text-left rounded-md border border-dashed border-violet-400/60 bg-violet-50 px-3 py-2 text-xs text-violet-700 ">
          <span className="opacity-70">Smart compose · Tab to accept</span><br/>{smartCompletion.slice(0, 240)}
        </button>
      )}
    </div>
  )

  const bottomBar = (
    <div className="flex items-center gap-2 px-4 py-3 border-t border-line/40 flex-shrink-0 flex-wrap">
      <button onClick={handleSend} disabled={isSending} aria-label={showSchedule ? 'Schedule email' : 'Send email'}
        className="btn-accent flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-semibold disabled:opacity-50">
        {isSending
          ? <><svg className="animate-spin" width="12" height="12" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="2" strokeDasharray="20" strokeDashoffset="5"/></svg> Sending…</>
          : <><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 1l10 5-10 5V7l7-1-7-1V1z" fill="currentColor"/></svg> {showSchedule ? 'Schedule' : 'Send'}</>
        }
      </button>
      <button
        onClick={() => {
          setShowSchedule(v => !v)
          if (!showSchedule && !scheduledAt) {
            const nextHour = new Date(Date.now() + 60 * 60 * 1000)
            setScheduledAt(new Date(nextHour.getTime() - nextHour.getTimezoneOffset() * 60_000).toISOString().slice(0, 16))
          }
        }}
        className={`px-3 py-2 rounded-xl text-[12px] font-medium transition-colors border ${
          showSchedule
            ? 'bg-accent/14 border-accent/50 text-accent-ink'
            : 'text-ink-2 border-line/60 hover:text-ink hover:bg-ink/5'
        }`}
      >
        Schedule
      </button>
      <select
        value={undoWindowSec}
        onChange={e => setUndoWindowSec(parseInt(e.target.value, 10))}
        title="Undo send window"
        className="field text-[12px] px-2 py-1.5 !rounded-xl text-ink-2"
      >
        <option value={0}>Undo off</option>
        <option value={60}>Undo 1 min</option>
        <option value={120}>Undo 2 min</option>
      </select>
      <div className="flex-1">
        <span className="text-[10px] text-ink-3 hidden sm:inline">Ctrl+Enter to send</span>
      </div>
      {templates.length > 0 && (
        <select defaultValue="" onChange={e => {
          const template = templates.find(t => t.id === e.target.value)
          if (!template) return
          if (template.subject) setSubject(template.subject)
          editor?.commands.setContent(template.body)
          e.currentTarget.value = ''
        }} className="text-[11px] px-2 py-1.5 rounded-md border border-line bg-white text-ink-2 ">
          <option value="">Template…</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
      <button onClick={() => fileInputRef.current?.click()} title="Attach files"
        className="p-2 text-ink-3 hover:text-ink hover:bg-surface-3 rounded-md transition-colors relative">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M14 7.5L7.5 14A5 5 0 01.5 7L6.5 1A3.5 3.5 0 0111.5 6L5.5 12A2 2 0 012.5 9L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        {attachments.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-accent text-[#201500] rounded-full text-[8px] font-bold flex items-center justify-center">{attachments.length}</span>
        )}
      </button>
      <button
        onClick={() => setShowAiPanel(!showAiPanel)}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold transition-all border
          ${showAiPanel
            ? 'bg-violet-50 text-violet-600 border-violet-300 '
            : 'text-ink-2 border-line hover:text-ink hover:border-violet-300 '
          }`}
      >
        AI Assist
      </button>
      <button onClick={handleSaveDraft} title="Save draft"
        className="px-2.5 py-2 rounded-md text-[11px] font-semibold text-ink-2 border border-line hover:text-ink transition-colors">
        Save draft
      </button>
      <button onClick={handleDiscard} title="Discard"
        className="p-2 text-ink-3 hover:text-danger hover:bg-surface-3 rounded-md transition-colors">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6L12 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
    </div>
  )
  const headerBar = (title: string) => (
    <div className="flex items-center justify-between px-4 py-3 border-b border-line/40 flex-shrink-0">
      <span className="text-ink font-semibold text-[14px] tracking-[-0.01em]">{title}</span>
      <div className="flex items-center gap-2">
        <button onClick={() => setIsExpanded(e => !e)}
          className="btn-ghost w-7 h-7 flex items-center justify-center"
          title={isExpanded ? 'Restore' : 'Expand'}>
          {isExpanded
            ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 4L4 10M4 4h6M4 10v-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            : <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 10L10 4M10 10H4M10 4v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          }
        </button>
        <button onClick={handleClose} aria-label="Close composer" className="btn-ghost w-7 h-7 flex items-center justify-center hover:!text-danger hover:!bg-danger/10" title="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
      </div>
    </div>
  )

  if (isExpanded) {
    const expandedContent = (
      <div className="absolute inset-0 z-50 flex flex-col bg-white ">
        {/* Compose area takes full space */}
        <div className="flex flex-col flex-1 min-h-0">
          {headerBar(composeData.replyTo ? 'Reply' : 'New Message')}
          {composeFields}
          {/* AI panel docked at bottom when expanded */}
          {showAiPanel && (
            <div className="border-t border-line flex flex-col flex-shrink-0" style={{ height: `${expandedAiHeight}px` }}>
              <div
                className="h-2 cursor-row-resize bg-surface-3 hover:bg-line transition-colors"
                onMouseDown={handleAiResizeStart}
                title="Drag to resize AI panel"
              />
              <div className="flex items-center justify-between px-4 py-2 bg-surface-2 border-b border-line ">
                <div className="flex items-center gap-2">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center ${
                    aiProvider === 'openai' ? 'bg-[#10a37f]' : aiProvider === 'gemini' ? 'bg-[#4285F4]' : 'bg-accent-ink'
                  }`}>
                    <span className="text-[8px] text-white font-bold">{aiProvider === 'openai' ? 'AI' : aiProvider === 'gemini' ? 'G' : 'C'}</span>
                  </div>
                  <span className="text-xs font-semibold text-ink ">
                    {aiProvider === 'openai' ? 'ChatGPT' : aiProvider === 'gemini' ? 'Gemini' : 'Claude'} AI
                  </span>
                </div>
                <button onClick={() => setShowAiPanel(false)} aria-label="Close AI panel" className="btn-ghost w-7 h-7 flex items-center justify-center">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
              </div>
              <div className="flex flex-1 min-h-0 overflow-hidden">
                {/* Modes column */}
                <div className="w-80 border-r border-line p-2 flex-shrink-0 overflow-y-auto">
                  <div className="grid grid-cols-3 gap-1 mb-2">
                    {AI_MODES.map(mode => (
                      <button key={mode.value} onClick={() => setAiMode(mode.value)} title={mode.description}
                        className={`flex flex-col items-center gap-0.5 p-1.5 rounded-md text-[10px] transition-colors border
                          ${aiMode === mode.value
                            ? 'bg-ai/12 text-ai border-ai/40'
                            : 'text-ink-2 border-transparent hover:bg-surface-3 '
                          }`}>
                        <span>{mode.icon}</span>
                        <span className="leading-tight text-center">{mode.label}</span>
                      </button>
                    ))}
                  </div>
                  {aiMode === 'custom' && (
                    <textarea value={customPrompt} onChange={e => setCustomPrompt(e.target.value)}
                      placeholder="Your instruction…" rows={2}
                      className="w-full p-2 text-xs bg-surface-2 border border-line text-ink placeholder-ink-3 rounded-md resize-none focus:outline-none focus:border-violet-400" />
                  )}
                  <button onClick={handleAiSuggest} disabled={aiMode === 'custom' && !customPrompt}
                    className={`mt-1 w-full py-1.5 rounded-md text-xs font-semibold transition-colors
                      ${isAiLoading
                        ? 'bg-red-50 border border-red-300 text-red-600 '
                        : 'bg-gradient-to-r from-violet-600 to-blue-600 text-white hover:from-violet-500 hover:to-blue-500 disabled:opacity-40'
                      }`}>
                    {isAiLoading ? '⏹ Stop' : `✦ Ask ${aiProvider === 'openai' ? 'ChatGPT' : aiProvider === 'gemini' ? 'Gemini' : 'Claude'}`}
                  </button>
                </div>
                {/* Suggestion column */}
                <div className="flex-1 overflow-y-auto p-3">
                  {isAiLoading && !aiSuggestion && (
                    <div className="flex items-center gap-2 text-violet-500 text-xs">
                      <span>Thinking…</span>
                      <span className="flex gap-1">{[0,1,2].map(i => <span key={i} className="ai-loading-dot w-1 h-1 rounded-full bg-violet-500 inline-block" />)}</span>
                    </div>
                  )}
                  {aiSuggestion && (
                    <div className="text-[12.5px] text-ink bg-ink/4 border border-line/50 rounded-xl p-3.5 whitespace-pre-wrap leading-relaxed">
                      {aiSuggestion}{isAiLoading && <span className="animate-pulse text-violet-400">▌</span>}
                    </div>
                  )}
                  {!aiSuggestion && !isAiLoading && !aiError && (
                    <div className="text-[11px] text-ink-3 py-2">Select a mode and click Ask to get a suggestion.</div>
                  )}
                  {aiError && <div className="text-[11px] text-red-600 bg-red-50 rounded-md p-2">{aiError}</div>}
                  {aiDone && aiSuggestion && (
                    <div className="flex gap-2 mt-2">
                      <button onClick={applyAiSuggestion} className="flex-1 bg-accent text-[#201500] py-1.5 rounded-md text-xs font-bold hover:bg-accent transition-colors">✓ Apply</button>
                      <button onClick={() => { setAiSuggestion(''); setAiDone(false) }} className="px-3 text-ink-3 hover:text-ink text-xs">✕</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {bottomBar}
        </div>
      </div>
    )

    const host = document.getElementById('email-content-host')
    if (host) return createPortal(expandedContent, host)
    return expandedContent
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end p-4 pointer-events-none">
      <div className="flex gap-3 pointer-events-auto">

        {/* AI Panel (float mode) */}
        {showAiPanel && (
          <div className="w-72 glass-elevated rounded-2xl flex flex-col overflow-hidden animate-rise" style={{ height: '520px' }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-line/40">
              <div className="flex items-center gap-2">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center ${
                  aiProvider === 'openai' ? 'bg-[#10a37f]' : aiProvider === 'gemini' ? 'bg-[#4285F4]' : 'bg-accent-ink'
                }`}>
                  <span className="text-[9px] text-white font-bold">{aiProvider === 'openai' ? 'AI' : aiProvider === 'gemini' ? 'G' : 'C'}</span>
                </div>
                <span className="font-semibold text-[13.5px] text-ink">
                  {aiProvider === 'openai' ? 'ChatGPT' : aiProvider === 'gemini' ? 'Gemini' : 'Claude'} AI
                </span>
                {!aiConfigured && (
                  <span className="text-[10px] bg-accent/18 text-accent-ink px-1.5 py-0.5 rounded-md font-medium">no key</span>
                )}
              </div>
              <button onClick={() => setShowAiPanel(false)} aria-label="Close AI panel" className="btn-ghost w-7 h-7 flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            </div>
            {aiPanelContent}
          </div>
        )}

        {/* Compose window (float mode) */}
        <div className="w-[560px] glass-elevated rounded-2xl flex flex-col overflow-hidden animate-rise" style={{ height: '560px' }}>
          {headerBar(composeData.replyTo ? 'Reply' : 'New Message')}
          {composeFields}
          {bottomBar}
        </div>
      </div>
    </div>
  )
}


