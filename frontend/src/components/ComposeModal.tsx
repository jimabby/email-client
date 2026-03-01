import { useState, useRef, useCallback } from 'react'
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

export function ComposeModal() {
  const { composeData, accounts, closeCompose, showNotification, aiProvider, aiConfigured } = useEmailStore()

  const [to, setTo]           = useState(composeData?.to || '')
  const [cc, setCc]           = useState(composeData?.cc || '')
  const [bcc, setBcc]         = useState(composeData?.bcc || '')
  const [subject, setSubject] = useState(composeData?.subject || '')
  const [body, setBody]       = useState(composeData?.body || '')
  const [accountId, setAccountId] = useState(composeData?.accountId || accounts[0]?.id || '')
  const [showCcBcc, setShowCcBcc] = useState(!!(composeData?.cc || composeData?.bcc))
  const [isSending, setIsSending] = useState(false)

  const [showAiPanel, setShowAiPanel]   = useState(false)
  const [aiMode, setAiMode]             = useState<AiMode>('improve')
  const [customPrompt, setCustomPrompt] = useState('')
  const [aiSuggestion, setAiSuggestion] = useState('')
  const [isAiLoading, setIsAiLoading]   = useState(false)
  const [aiDone, setAiDone]             = useState(false)
  const [aiError, setAiError]           = useState('')
  const abortRef = useRef<{ abort: () => void } | null>(null)

  const handleSend = async () => {
    if (!to || !subject) { showNotification('error', 'Please fill in To and Subject fields'); return }
    if (!accountId) { showNotification('error', 'Please select an account'); return }
    setIsSending(true)
    try {
      await emailsApi.send(accountId, {
        to, cc: cc || undefined, bcc: bcc || undefined, subject,
        html: `<div style="font-family: Calibri, sans-serif; font-size: 14px; white-space: pre-wrap;">${body.replace(/\n/g, '<br>')}</div>`,
        text: body
      })
      showNotification('success', 'Email sent!')
      closeCompose()
    } catch (err: unknown) {
      showNotification('error', err instanceof Error ? err.message : 'Failed to send email')
    } finally { setIsSending(false) }
  }

  const handleAiSuggest = useCallback(async () => {
    if (isAiLoading) { abortRef.current?.abort(); setIsAiLoading(false); return }
    setIsAiLoading(true); setAiDone(false); setAiSuggestion(''); setAiError('')
    const replyTo = composeData?.replyTo
      ? { from: composeData.replyTo.from, subject: composeData.replyTo.subject, body: composeData.replyTo.text || '' }
      : undefined
    const controller = await streamAiSuggestion(
      { subject, body, mode: aiMode, customPrompt: aiMode === 'custom' ? customPrompt : undefined, replyTo },
      (text) => setAiSuggestion(prev => prev + text),
      () => { setIsAiLoading(false); setAiDone(true) },
      (err) => { setIsAiLoading(false); setAiError(err) }
    )
    abortRef.current = { abort: () => controller.abort() }
  }, [subject, body, aiMode, customPrompt, composeData, isAiLoading])

  const applyAiSuggestion = () => {
    if (aiMode === 'subject') {
      const first = aiSuggestion.split('\n').filter(l => l.trim())[0]?.replace(/^\d+\.\s*/, '').trim()
      if (first) setSubject(first)
    } else { setBody(aiSuggestion) }
    setAiSuggestion(''); setAiDone(false)
    showNotification('success', 'AI suggestion applied!')
  }

  if (!composeData) return null

  // Shared class snippets
  const rowCls   = 'flex items-center gap-2 px-4 py-2.5 border-b border-[#d0d7de] dark:border-[#30363d]'
  const labelCls = 'text-[11px] text-[#818b98] dark:text-[#484f58] w-12 flex-shrink-0'
  const inputCls = 'flex-1 text-sm bg-transparent text-[#1f2328] dark:text-[#e6edf3] placeholder-[#818b98] dark:placeholder-[#484f58] focus:outline-none'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end p-4 pointer-events-none">
      <div className="flex gap-3 pointer-events-auto">

        {/* AI Panel */}
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

            <div className="flex-1 overflow-y-auto p-3">
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
              <div className="p-3 border-t border-[#d0d7de] dark:border-[#30363d] flex gap-2">
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
          </div>
        )}

        {/* Compose window */}
        <div className="w-[540px] bg-white dark:bg-[#161b22] border border-[#d0d7de] dark:border-[#30363d] rounded-xl shadow-2xl flex flex-col" style={{ height: '520px' }}>
          <div className="flex items-center justify-between px-4 py-3 bg-[#f6f8fa] dark:bg-[#1c2128] border-b border-[#d0d7de] dark:border-[#30363d] rounded-t-xl">
            <span className="text-[#1f2328] dark:text-[#e6edf3] font-semibold text-sm">
              {composeData.replyTo ? 'Reply' : 'New Message'}
            </span>
            <div className="flex items-center gap-2">
              <button onClick={closeCompose} className="text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] transition-colors p-0.5" title="Minimize">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
              <button onClick={closeCompose} className="text-[#818b98] dark:text-[#484f58] hover:text-[#cf222e] dark:hover:text-[#f85149] transition-colors p-0.5" title="Close">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            </div>
          </div>

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
              <input type="email" value={to} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com" className={inputCls} multiple />
              <button onClick={() => setShowCcBcc(!showCcBcc)} className="text-[10px] text-[#818b98] dark:text-[#484f58] hover:text-[#f59e0b] transition-colors">Cc Bcc</button>
            </div>
            {showCcBcc && (
              <>
                <div className={rowCls}>
                  <span className={labelCls}>Cc</span>
                  <input type="text" value={cc} onChange={e => setCc(e.target.value)} placeholder="cc@example.com" className={inputCls} />
                </div>
                <div className={rowCls}>
                  <span className={labelCls}>Bcc</span>
                  <input type="text" value={bcc} onChange={e => setBcc(e.target.value)} placeholder="bcc@example.com" className={inputCls} />
                </div>
              </>
            )}
            <div className={rowCls}>
              <span className={labelCls}>Subject</span>
              <input type="text" value={subject} onChange={e => setSubject(e.target.value)} placeholder="Email subject" className={`${inputCls} font-medium`} />
            </div>
            {composeData.replyTo && (
              <div className="px-4 py-2 border-b border-[#d0d7de] dark:border-[#30363d] bg-[#f6f8fa] dark:bg-[#1c2128]">
                <div className="text-[10px] text-[#818b98] dark:text-[#484f58]">
                  Replying to <span className="text-[#656d76] dark:text-[#8b949e]">{composeData.replyTo.from}</span>
                </div>
              </div>
            )}
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Write your email…"
              className="flex-1 px-4 py-3 text-sm bg-transparent text-[#24292f] dark:text-[#c9d1d9] placeholder-[#818b98] dark:placeholder-[#484f58] focus:outline-none resize-none font-sans leading-relaxed"
            />

            <div className="flex items-center gap-2 px-4 py-2.5 border-t border-[#d0d7de] dark:border-[#30363d] bg-[#f6f8fa] dark:bg-[#1c2128] rounded-b-xl">
              <button onClick={handleSend} disabled={isSending}
                className="flex items-center gap-1.5 bg-[#f59e0b] text-[#0d1117] px-4 py-2 rounded-md text-xs font-bold hover:bg-[#fbbf24] transition-colors disabled:opacity-50">
                {isSending
                  ? <><span className="animate-spin inline-block">⟳</span> Sending…</>
                  : <><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 1l10 5-10 5V7l7-1-7-1V1z" fill="currentColor"/></svg> Send</>
                }
              </button>
              <div className="flex-1" />
              <button
                onClick={() => setShowAiPanel(!showAiPanel)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold transition-all border
                  ${showAiPanel
                    ? 'bg-violet-50 dark:bg-violet-600/20 text-violet-600 dark:text-violet-400 border-violet-300 dark:border-violet-500/30'
                    : 'text-[#656d76] dark:text-[#8b949e] border-[#d0d7de] dark:border-[#30363d] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:border-violet-300 dark:hover:border-violet-500/30'
                  }`}
              >
                ✦ AI Assist
              </button>
              <button onClick={closeCompose} title="Discard"
                className="p-2 text-[#818b98] dark:text-[#484f58] hover:text-[#cf222e] dark:hover:text-[#f85149] hover:bg-[#eaeef2] dark:hover:bg-[#21262d] rounded-md transition-colors">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6L12 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
