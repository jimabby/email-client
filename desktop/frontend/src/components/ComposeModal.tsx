import { useState, useRef, useCallback, useEffect, type ChangeEvent } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { createPortal } from 'react-dom'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { useEmailStore } from '../store/emailStore'
import { emailsApi, streamAiSuggestion } from '../api/client'
import type { AiMode } from '../types/email'

const AI_MODES: { value: AiMode; label: string; icon: string; description: string }[] = [
  { value: 'improve',  label: 'Improve',      icon: '✨', description: 'Make it more professional and clear' },
  { value: 'concise',  label: 'Concise',       icon: '✂️', description: 'Shorten without losing meaning' },
  { value: 'complete', label: 'Complete',      icon: '✍️', description: 'Finish what you started' },
  { value: 'grammar',  label: 'Fix Grammar',   icon: '🔤', description: 'Fix grammar and spelling' },
  { value: 'formal',   label: 'Formal',        icon: '👔', description: 'Rewrite in formal tone' },
  { value: 'friendly', label: 'Friendly',      icon: '😊', description: 'Make it warm and approachable' },
  { value: 'subject',  label: 'Subject Ideas', icon: '💡', description: 'Suggest subject line options' },
  { value: 'reply',    label: 'Draft Reply',   icon: '↩',  description: 'Auto-draft a reply' },
  { value: 'custom',   label: 'Custom',        icon: '🎯', description: 'Give your own instruction' },
]

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
        className="w-full text-sm bg-transparent text-[#1f2328] dark:text-[#e6edf3] placeholder-[#818b98] dark:placeholder-[#484f58] focus:outline-none"
      />
      {suggestions.length > 0 && (
        <div className="absolute left-0 top-full mt-1 w-64 bg-white dark:bg-[#161b22] border border-[#d0d7de] dark:border-[#30363d] rounded-lg shadow-xl z-50 py-1 max-h-40 overflow-y-auto">
          {suggestions.map((s, i) => (
            <button
              key={s}
              onMouseDown={e => { e.preventDefault(); selectSuggestion(s) }}
              className={`w-full text-left px-3 py-1.5 text-xs truncate transition-colors ${
                i === activeIdx ? 'bg-[#eaeef2] dark:bg-[#21262d] text-[#1f2328] dark:text-[#e6edf3]' : 'text-[#24292f] dark:text-[#c9d1d9] hover:bg-[#eaeef2] dark:hover:bg-[#21262d]'
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
        ? 'bg-[#eaeef2] dark:bg-[#21262d] text-[#1f2328] dark:text-[#e6edf3]'
        : 'text-[#818b98] dark:text-[#484f58] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] hover:text-[#1f2328] dark:hover:text-[#e6edf3]'
    }`

  const setLink = () => {
    const prev = editor.getAttributes('link').href
    const url = window.prompt('Enter URL', prev || 'https://')
    if (!url) { editor.chain().focus().unsetLink().run(); return }
    editor.chain().focus().setLink({ href: url }).run()
  }

  return (
    <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-[#d0d7de] dark:border-[#30363d] bg-[#f6f8fa] dark:bg-[#1c2128]">
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} className={btn(editor.isActive('bold'))} title="Bold">B</button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} className={`${btn(editor.isActive('italic'))} italic`} title="Italic">I</button>
      <button type="button" onClick={() => editor.chain().focus().toggleUnderline().run()} className={`${btn(editor.isActive('underline'))} underline`} title="Underline">U</button>
      <div className="w-px h-4 bg-[#d0d7de] dark:bg-[#30363d] mx-1" />
      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} className={btn(editor.isActive('bulletList'))} title="Bullet list">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="2" cy="3.5" r="1" fill="currentColor"/><line x1="5" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="2" cy="7" r="1" fill="currentColor"/><line x1="5" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="2" cy="10.5" r="1" fill="currentColor"/><line x1="5" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={btn(editor.isActive('orderedList'))} title="Ordered list">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><text x="0" y="5" fontSize="5" fill="currentColor">1.</text><line x1="5" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><text x="0" y="9" fontSize="5" fill="currentColor">2.</text><line x1="5" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><text x="0" y="13" fontSize="5" fill="currentColor">3.</text><line x1="5" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
      </button>
      <div className="w-px h-4 bg-[#d0d7de] dark:bg-[#30363d] mx-1" />
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
  } = useEmailStore()

  const isReply = !!composeData?.replyTo

  const [to, setTo]           = useState(composeData?.to || '')
  const [cc, setCc]           = useState(composeData?.cc || '')
  const [bcc, setBcc]         = useState(composeData?.bcc || '')
  const [subject, setSubject] = useState(composeData?.subject || '')
  const [accountId, setAccountId] = useState(composeData?.accountId || accounts[0]?.id || '')
  const [showCcBcc, setShowCcBcc] = useState(!!(composeData?.cc || composeData?.bcc))
  const [isSending, setIsSending] = useState(false)
  const [attachments, setAttachments] = useState<File[]>([])
  const [undoWindowSec, setUndoWindowSec] = useState(60)
  const [showSchedule, setShowSchedule] = useState(false)
  const [scheduledAt, setScheduledAt] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [isExpanded, setIsExpanded]     = useState(false)
  const [showAiPanel, setShowAiPanel]   = useState(false)
  const [aiMode, setAiMode]             = useState<AiMode>('improve')
  const [customPrompt, setCustomPrompt] = useState('')
  const [aiSuggestion, setAiSuggestion] = useState('')
  const [isAiLoading, setIsAiLoading]   = useState(false)
  const [aiDone, setAiDone]             = useState(false)
  const [aiError, setAiError]           = useState('')
  const [expandedAiHeight, setExpandedAiHeight] = useState(220)
  const abortRef = useRef<{ abort: () => void } | null>(null)
  const resizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null)

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
        class: 'flex-1 px-4 py-3 text-sm text-[#24292f] dark:text-[#c9d1d9] leading-relaxed focus:outline-none min-h-[120px]',
      },
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault()
          sendRef.current()
          return true
        }
        return false
      },
    },
  })

  const readFileAsBase64 = (file: File): Promise<{ filename: string; contentType: string; content: string }> =>
    new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1]
        resolve({ filename: file.name, contentType: file.type || 'application/octet-stream', content: base64 })
      }
      reader.readAsDataURL(file)
    })

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) setAttachments(prev => [...prev, ...Array.from(e.target.files!)])
    e.target.value = ''
  }

  const handleSend = async () => {
    if (!to || !subject) { showNotification('error', 'Please fill in To and Subject fields'); return }
    if (!accountId) { showNotification('error', 'Please select an account'); return }
    if (showSchedule && !scheduledAt) { showNotification('error', 'Please choose a scheduled send time'); return }
    setIsSending(true)
    try {
      const html = editor?.getHTML() || ''
      const text = editor?.getText() || ''
      const attachmentData = attachments.length ? await Promise.all(attachments.map(readFileAsBase64)) : undefined
      const sendResult = await emailsApi.send(accountId, {
        to, cc: cc || undefined, bcc: bcc || undefined, subject,
        html, text, attachments: attachmentData,
        sendAt: showSchedule && scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        undoWindowSec: undoWindowSec > 0 ? undoWindowSec : undefined,
      })
      // Save contacts for autocomplete
      const parseAddresses = (s: string) => s.split(',').map(a => a.trim()).filter(Boolean)
      addContacts([...parseAddresses(to), ...parseAddresses(cc), ...parseAddresses(bcc)])

      if (sendResult.queued) {
        const when = sendResult.sendAt ? new Date(sendResult.sendAt).toLocaleString() : 'soon'
        const undoTimeoutMs = sendResult.canUndoUntil
          ? Math.max(4500, new Date(sendResult.canUndoUntil).getTime() - Date.now() + 1200)
          : 4500
        const undoLabel = undoWindowSec >= 60 ? `${Math.round(undoWindowSec / 60)} min` : `${undoWindowSec}s`

        const action = (undoWindowSec > 0 && sendResult.jobId)
          ? {
              label: 'Undo',
              onClick: async () => {
                try {
                  await emailsApi.cancelQueuedSend(accountId, sendResult.jobId!)
                  showNotification('success', 'Scheduled send cancelled')
                } catch (err: unknown) {
                  showNotification('error', err instanceof Error ? err.message : 'Failed to cancel scheduled send')
                }
              }
            }
          : undefined

        showNotification(
          'success',
          `Email queued for ${when}${undoWindowSec > 0 ? ` (undo ${undoLabel})` : ''}`,
          { action, timeoutMs: undoTimeoutMs }
        )
      } else {
        showNotification('success', 'Email sent!')
      }
      closeCompose()
    } catch (err: unknown) {
      showNotification('error', err instanceof Error ? err.message : 'Failed to send email')
    } finally { setIsSending(false) }
  }
  sendRef.current = handleSend

  const handleAiSuggest = useCallback(async () => {
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
    const controller = await streamAiSuggestion(
      { subject, body: bodyText, mode: aiMode, customPrompt: aiMode === 'custom' ? customPrompt : undefined, replyTo },
      (text) => setAiSuggestion(prev => prev + text),
      () => { setIsAiLoading(false); setAiDone(true) },
      (err) => { setIsAiLoading(false); setAiError(err) }
    )
    abortRef.current = { abort: () => controller.abort() }
  }, [subject, editor, aiMode, customPrompt, composeData, isAiLoading])

  const applyAiSuggestion = () => {
    if (aiMode === 'subject') {
      const first = aiSuggestion.split('\n').filter(l => l.trim())[0]?.replace(/^\d+\.\s*/, '').trim()
      if (first) setSubject(first)
    } else {
      editor?.commands.setContent(`<p>${aiSuggestion.replace(/\n/g, '</p><p>')}</p>`)
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

  const rowCls   = 'flex items-center gap-2 px-4 py-2.5 border-b border-[#d0d7de] dark:border-[#30363d]'
  const labelCls = 'text-[11px] text-[#818b98] dark:text-[#484f58] w-12 flex-shrink-0'

  // Shared AI panel content (used in both modes)
  const aiPanelContent = (
    <>
      <div className="p-3 border-b border-[#d0d7de] dark:border-[#30363d]">
        <p className="text-[10px] text-[#818b98] dark:text-[#484f58] mb-2 uppercase tracking-wide font-semibold">Mode</p>
        <div className="grid grid-cols-3 gap-1">
          {AI_MODES.map(mode => (
            <button
              key={mode.value}
              onClick={() => setAiMode(mode.value)}
              title={mode.description}
              className={`flex flex-col items-center gap-0.5 p-1.5 rounded-md text-[10px] transition-colors border
                ${aiMode === mode.value
                  ? 'bg-violet-50 dark:bg-[rgba(139,92,246,0.15)] text-violet-600 dark:text-violet-400 border-violet-300 dark:border-violet-500/30'
                  : 'text-[#656d76] dark:text-[#8b949e] border-transparent hover:bg-[#eaeef2] dark:hover:bg-[#21262d] hover:text-[#1f2328] dark:hover:text-[#e6edf3]'
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
            className="mt-2 w-full p-2 text-xs bg-[#f6f8fa] dark:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] text-[#1f2328] dark:text-[#e6edf3] placeholder-[#818b98] dark:placeholder-[#484f58] rounded-md resize-none focus:outline-none focus:border-violet-400"
            rows={2}
          />
        )}

        <button
          onClick={handleAiSuggest}
          disabled={aiMode === 'custom' && !customPrompt}
          className={`mt-2 w-full py-2 rounded-md text-xs font-semibold transition-colors
            ${isAiLoading
              ? 'bg-red-50 dark:bg-[#f85149]/20 border border-red-300 dark:border-[#f85149]/40 text-red-600 dark:text-[#f85149] hover:bg-red-100 dark:hover:bg-[#f85149]/30'
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
            <div className="text-[10px] text-[#818b98] dark:text-[#484f58] mb-1.5 font-semibold uppercase tracking-wide">
              Suggestion {isAiLoading && <span className="text-violet-500 ml-1 normal-case">streaming…</span>}
            </div>
            <div className="text-xs text-[#24292f] dark:text-[#c9d1d9] bg-[#f6f8fa] dark:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] rounded-md p-3 whitespace-pre-wrap leading-relaxed">
              {aiSuggestion}
              {isAiLoading && <span className="animate-pulse text-violet-400">▌</span>}
            </div>
          </div>
        )}
        {aiError && (
          <div className="text-[11px] text-red-600 dark:text-[#f85149] bg-red-50 dark:bg-[#f85149]/10 border border-red-200 dark:border-[#f85149]/30 rounded-md p-2.5 leading-relaxed">
            <div className="font-semibold mb-0.5">Error</div>
            {aiError}
          </div>
        )}
        {!aiSuggestion && !isAiLoading && !aiError && (
          <div className="text-[11px] text-[#818b98] dark:text-[#484f58] text-center py-4 leading-relaxed">
            Select a mode and click<br/>"{`Ask ${aiProvider === 'openai' ? 'ChatGPT' : aiProvider === 'gemini' ? 'Gemini' : 'Claude'}`}" to get started.
          </div>
        )}
      </div>

      {aiDone && aiSuggestion && (
        <div className="p-3 border-t border-[#d0d7de] dark:border-[#30363d] flex gap-2 flex-shrink-0">
          <button onClick={applyAiSuggestion}
            className="flex-1 bg-[#f59e0b] text-[#0d1117] py-2 rounded-md text-xs font-bold hover:bg-[#fbbf24] transition-colors">
            ✓ Apply to Email
          </button>
          <button onClick={() => { setAiSuggestion(''); setAiDone(false) }}
            className="px-3 py-2 text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md text-xs transition-colors">
            ✕
          </button>
        </div>
      )}
    </>
  )

  // Shared compose fields + editor
  const composeFields = (
    <div className="flex flex-col flex-1 min-h-0">
      {accounts.length > 1 && (
        <div className={rowCls}>
          <span className={labelCls}>From</span>
          <select value={accountId} onChange={e => setAccountId(e.target.value)}
            className="flex-1 text-xs bg-transparent text-[#1f2328] dark:text-[#e6edf3] focus:outline-none">
            {accounts.map(a => <option key={a.id} value={a.id} className="bg-white dark:bg-[#161b22]">{a.email}</option>)}
          </select>
        </div>
      )}
      <div className={rowCls}>
        <span className={labelCls}>To</span>
        <ContactField value={to} onChange={setTo} contacts={contacts} placeholder="recipient@example.com" label="To" />
        <button onClick={() => setShowCcBcc(!showCcBcc)} className="text-[10px] text-[#818b98] dark:text-[#484f58] hover:text-[#f59e0b] transition-colors flex-shrink-0">Cc Bcc</button>
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
          className="flex-1 text-sm font-medium bg-transparent text-[#1f2328] dark:text-[#e6edf3] placeholder-[#818b98] dark:placeholder-[#484f58] focus:outline-none" />
      </div>
      {showSchedule && (
        <div className={rowCls}>
          <span className={labelCls}>Send at</span>
          <input
            type="datetime-local"
            value={scheduledAt}
            min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
            onChange={e => setScheduledAt(e.target.value)}
            className="flex-1 text-xs bg-transparent text-[#1f2328] dark:text-[#e6edf3] focus:outline-none"
          />
        </div>
      )}
      {composeData.replyTo && (
        <div className="px-4 py-2 border-b border-[#d0d7de] dark:border-[#30363d] bg-[#f6f8fa] dark:bg-[#1c2128]">
          <div className="text-[10px] text-[#818b98] dark:text-[#484f58]">
            Replying to <span className="text-[#656d76] dark:text-[#8b949e]">{composeData.replyTo.from}</span>
          </div>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="px-4 py-2 border-b border-[#d0d7de] dark:border-[#30363d] flex flex-wrap gap-1.5">
          {attachments.map((f, i) => (
            <div key={i} className="flex items-center gap-1 bg-[#eaeef2] dark:bg-[#21262d] rounded px-2 py-1 text-[11px] text-[#1f2328] dark:text-[#e6edf3]">
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M10 4L6 8.5a2 2 0 01-3-2.5L8 1a3 3 0 014 4.5L5.5 11A4 4 0 01.5 5.5L6 0" stroke="#f59e0b" strokeWidth="1.2" strokeLinecap="round"/></svg>
              <span className="max-w-[120px] truncate">{f.name}</span>
              <span className="text-[#818b98] dark:text-[#484f58]">({Math.round(f.size / 1024)}KB)</span>
              <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} className="ml-0.5 text-[#818b98] hover:text-[#cf222e] dark:hover:text-[#f85149]">×</button>
            </div>
          ))}
        </div>
      )}
      <RichToolbar editor={editor} />
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} className="h-full" />
      </div>
    </div>
  )

  const bottomBar = (
    <div className="flex items-center gap-2 px-4 py-2.5 border-t border-[#d0d7de] dark:border-[#30363d] bg-[#f6f8fa] dark:bg-[#1c2128] rounded-b-xl flex-shrink-0">
      <button onClick={handleSend} disabled={isSending} aria-label={showSchedule ? 'Schedule email' : 'Send email'}
        className="flex items-center gap-1.5 bg-[#f59e0b] text-[#0d1117] px-4 py-2 rounded-md text-xs font-bold hover:bg-[#fbbf24] transition-colors disabled:opacity-50">
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
        className={`px-2.5 py-2 rounded-md text-[11px] font-semibold transition-colors border ${
          showSchedule
            ? 'bg-[#fff8ec] border-[#f59e0b] text-[#b45309]'
            : 'text-[#656d76] dark:text-[#8b949e] border-[#d0d7de] dark:border-[#30363d] hover:text-[#1f2328] dark:hover:text-[#e6edf3]'
        }`}
      >
        Schedule
      </button>
      <select
        value={undoWindowSec}
        onChange={e => setUndoWindowSec(parseInt(e.target.value, 10))}
        title="Undo send window"
        className="text-[11px] px-2 py-1.5 rounded-md border border-[#d0d7de] dark:border-[#30363d] bg-white dark:bg-[#161b22] text-[#656d76] dark:text-[#8b949e] focus:outline-none"
      >
        <option value={0}>Undo off</option>
        <option value={60}>Undo 1 min</option>
        <option value={120}>Undo 2 min</option>
      </select>
      <div className="flex-1">
        <span className="text-[10px] text-[#afb8c1] dark:text-[#484f58] hidden sm:inline">Ctrl+Enter to send</span>
      </div>
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
      <button onClick={() => fileInputRef.current?.click()} title="Attach files"
        className="p-2 text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors relative">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M14 7.5L7.5 14A5 5 0 01.5 7L6.5 1A3.5 3.5 0 0111.5 6L5.5 12A2 2 0 012.5 9L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        {attachments.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-[#f59e0b] text-[#0d1117] rounded-full text-[8px] font-bold flex items-center justify-center">{attachments.length}</span>
        )}
      </button>
      <button
        onClick={() => setShowAiPanel(!showAiPanel)}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold transition-all border
          ${showAiPanel
            ? 'bg-violet-50 dark:bg-violet-600/20 text-violet-600 dark:text-violet-400 border-violet-300 dark:border-violet-500/30'
            : 'text-[#656d76] dark:text-[#8b949e] border-[#d0d7de] dark:border-[#30363d] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:border-violet-300 dark:hover:border-violet-500/30'
          }`}
      >
        AI Assist
      </button>
      <button onClick={closeCompose} title="Discard"
        className="p-2 text-[#818b98] dark:text-[#484f58] hover:text-[#cf222e] dark:hover:text-[#f85149] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6L12 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
    </div>
  )
  const headerBar = (title: string) => (
    <div className="flex items-center justify-between px-4 py-3 bg-[#f6f8fa] dark:bg-[#1c2128] border-b border-[#d0d7de] dark:border-[#30363d] rounded-t-xl flex-shrink-0">
      <span className="text-[#1f2328] dark:text-[#e6edf3] font-semibold text-sm">{title}</span>
      <div className="flex items-center gap-2">
        <button onClick={() => setIsExpanded(e => !e)}
          className="text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] transition-colors p-0.5"
          title={isExpanded ? 'Restore' : 'Expand'}>
          {isExpanded
            ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10 4L4 10M4 4h6M4 10v-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            : <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M4 10L10 4M10 10H4M10 4v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          }
        </button>
        <button onClick={closeCompose} className="text-[#818b98] dark:text-[#484f58] hover:text-[#cf222e] dark:hover:text-[#f85149] transition-colors p-0.5" title="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
      </div>
    </div>
  )

  if (isExpanded) {
    const expandedContent = (
      <div className="absolute inset-0 z-50 flex flex-col bg-white dark:bg-[#161b22]">
        {/* Compose area takes full space */}
        <div className="flex flex-col flex-1 min-h-0">
          {headerBar(composeData.replyTo ? 'Reply' : 'New Message')}
          {composeFields}
          {/* AI panel docked at bottom when expanded */}
          {showAiPanel && (
            <div className="border-t border-[#d0d7de] dark:border-[#30363d] flex flex-col flex-shrink-0" style={{ height: `${expandedAiHeight}px` }}>
              <div
                className="h-2 cursor-row-resize bg-[#eaeef2] dark:bg-[#21262d] hover:bg-[#d0d7de] dark:hover:bg-[#30363d] transition-colors"
                onMouseDown={handleAiResizeStart}
                title="Drag to resize AI panel"
              />
              <div className="flex items-center justify-between px-4 py-2 bg-[#f6f8fa] dark:bg-[#1c2128] border-b border-[#d0d7de] dark:border-[#30363d]">
                <div className="flex items-center gap-2">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center ${
                    aiProvider === 'openai' ? 'bg-[#10a37f]' : aiProvider === 'gemini' ? 'bg-[#4285F4]' : 'bg-[#d97706]'
                  }`}>
                    <span className="text-[8px] text-white font-bold">{aiProvider === 'openai' ? 'AI' : aiProvider === 'gemini' ? 'G' : 'C'}</span>
                  </div>
                  <span className="text-xs font-semibold text-[#1f2328] dark:text-[#e6edf3]">
                    {aiProvider === 'openai' ? 'ChatGPT' : aiProvider === 'gemini' ? 'Gemini' : 'Claude'} AI
                  </span>
                </div>
                <button onClick={() => setShowAiPanel(false)} className="text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] transition-colors">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                </button>
              </div>
              <div className="flex flex-1 min-h-0 overflow-hidden">
                {/* Modes column */}
                <div className="w-80 border-r border-[#d0d7de] dark:border-[#30363d] p-2 flex-shrink-0 overflow-y-auto">
                  <div className="grid grid-cols-3 gap-1 mb-2">
                    {AI_MODES.map(mode => (
                      <button key={mode.value} onClick={() => setAiMode(mode.value)} title={mode.description}
                        className={`flex flex-col items-center gap-0.5 p-1.5 rounded-md text-[10px] transition-colors border
                          ${aiMode === mode.value
                            ? 'bg-violet-50 dark:bg-[rgba(139,92,246,0.15)] text-violet-600 dark:text-violet-400 border-violet-300 dark:border-violet-500/30'
                            : 'text-[#656d76] dark:text-[#8b949e] border-transparent hover:bg-[#eaeef2] dark:hover:bg-[#21262d]'
                          }`}>
                        <span>{mode.icon}</span>
                        <span className="leading-tight text-center">{mode.label}</span>
                      </button>
                    ))}
                  </div>
                  {aiMode === 'custom' && (
                    <textarea value={customPrompt} onChange={e => setCustomPrompt(e.target.value)}
                      placeholder="Your instruction…" rows={2}
                      className="w-full p-2 text-xs bg-[#f6f8fa] dark:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] text-[#1f2328] dark:text-[#e6edf3] placeholder-[#818b98] dark:placeholder-[#484f58] rounded-md resize-none focus:outline-none focus:border-violet-400" />
                  )}
                  <button onClick={handleAiSuggest} disabled={aiMode === 'custom' && !customPrompt}
                    className={`mt-1 w-full py-1.5 rounded-md text-xs font-semibold transition-colors
                      ${isAiLoading
                        ? 'bg-red-50 dark:bg-[#f85149]/20 border border-red-300 dark:border-[#f85149]/40 text-red-600 dark:text-[#f85149]'
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
                    <div className="text-xs text-[#24292f] dark:text-[#c9d1d9] bg-[#f6f8fa] dark:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] rounded-md p-3 whitespace-pre-wrap leading-relaxed">
                      {aiSuggestion}{isAiLoading && <span className="animate-pulse text-violet-400">▌</span>}
                    </div>
                  )}
                  {!aiSuggestion && !isAiLoading && !aiError && (
                    <div className="text-[11px] text-[#818b98] dark:text-[#484f58] py-2">Select a mode and click Ask to get a suggestion.</div>
                  )}
                  {aiError && <div className="text-[11px] text-red-600 dark:text-[#f85149] bg-red-50 dark:bg-[#f85149]/10 rounded-md p-2">{aiError}</div>}
                  {aiDone && aiSuggestion && (
                    <div className="flex gap-2 mt-2">
                      <button onClick={applyAiSuggestion} className="flex-1 bg-[#f59e0b] text-[#0d1117] py-1.5 rounded-md text-xs font-bold hover:bg-[#fbbf24] transition-colors">✓ Apply</button>
                      <button onClick={() => { setAiSuggestion(''); setAiDone(false) }} className="px-3 text-[#818b98] hover:text-[#1f2328] dark:hover:text-[#e6edf3] text-xs">✕</button>
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
          <div className="w-72 bg-white dark:bg-[#161b22] border border-[#d0d7de] dark:border-[#30363d] rounded-xl shadow-2xl flex flex-col" style={{ height: '520px' }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#d0d7de] dark:border-[#30363d] rounded-t-xl bg-[#f6f8fa] dark:bg-[#1c2128]">
              <div className="flex items-center gap-2">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center ${
                  aiProvider === 'openai' ? 'bg-[#10a37f]' : aiProvider === 'gemini' ? 'bg-[#4285F4]' : 'bg-[#d97706]'
                }`}>
                  <span className="text-[9px] text-white font-bold">{aiProvider === 'openai' ? 'AI' : aiProvider === 'gemini' ? 'G' : 'C'}</span>
                </div>
                <span className="font-semibold text-sm text-[#1f2328] dark:text-[#e6edf3]">
                  {aiProvider === 'openai' ? 'ChatGPT' : aiProvider === 'gemini' ? 'Gemini' : 'Claude'} AI
                </span>
                {!aiConfigured && (
                  <span className="text-[9px] bg-amber-100 dark:bg-[rgba(245,158,11,0.15)] text-amber-700 dark:text-[#d97706] px-1.5 py-0.5 rounded font-medium">no key</span>
                )}
              </div>
              <button onClick={() => setShowAiPanel(false)} className="text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] transition-colors">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            </div>
            {aiPanelContent}
          </div>
        )}

        {/* Compose window (float mode) */}
        <div className="w-[540px] bg-white dark:bg-[#161b22] border border-[#d0d7de] dark:border-[#30363d] rounded-xl shadow-2xl flex flex-col" style={{ height: '540px' }}>
          {headerBar(composeData.replyTo ? 'Reply' : 'New Message')}
          {composeFields}
          {bottomBar}
        </div>
      </div>
    </div>
  )
}


