import { useEffect, useRef, useState } from 'react'
import { streamAiChat } from '../api/client'
import { useEmailStore } from '../store/emailStore'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export function AiChatPanel() {
  const { emails, emailCategories, selectedEmail, selectedEmailBody, aiConfigured } = useEmailStore()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const controllerRef = useRef<{ abort: () => void } | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = async () => {
    const text = input.trim()
    if (!text || isStreaming) return

    const userMsg: Message = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setIsStreaming(true)

    // Build email context
    const emailContext = {
      emails: emails.slice(0, 50).map(e => ({
        from: e.from,
        subject: e.subject,
        date: e.date,
        read: e.read,
        category: emailCategories[e.id],
      })),
      currentEmail: selectedEmail && selectedEmailBody ? {
        from: selectedEmail.from,
        subject: selectedEmail.subject,
        body: selectedEmailBody.text || selectedEmailBody.html?.replace(/<[^>]+>/g, ' ') || '',
      } : null,
    }

    let assistantContent = ''
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])

    // The handle comes back synchronously, so "Stop" reaches the request that
    // is actually in flight.
    controllerRef.current = streamAiChat(
      { messages: newMessages, emailContext },
      (chunk) => {
        assistantContent += chunk
        setMessages(prev => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: assistantContent },
        ])
      },
      () => setIsStreaming(false),
      (err) => {
        setMessages(prev => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: `Error: ${err}` },
        ])
        setIsStreaming(false)
      }
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const clear = () => {
    controllerRef.current?.abort()
    setMessages([])
    setIsStreaming(false)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3.5 min-h-[52px] py-2 border-b border-line/40 flex items-center gap-2 flex-shrink-0">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-ai">
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M5.5 6.5C5.5 5.12 6.62 4 8 4s2.5 1.12 2.5 2.5c0 1.5-1.5 2-2 2.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          <circle cx="8" cy="11.5" r=".75" fill="currentColor"/>
        </svg>
        <span className="text-[14px] font-semibold text-ink flex-1 tracking-[-0.01em]">AI assistant</span>
        {messages.length > 0 && (
          <button onClick={clear} title="Clear chat"
            className="btn-ghost w-7 h-7 flex items-center justify-center hover:!text-danger">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3.5">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 pb-8">
            <div className="w-14 h-14 rounded-2xl bg-ai/12 flex items-center justify-center">
              <svg width="26" height="26" viewBox="0 0 16 16" fill="none" className="text-ai">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M5.5 6.5C5.5 5.12 6.62 4 8 4s2.5 1.12 2.5 2.5c0 1.5-1.5 2-2 2.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                <circle cx="8" cy="11.5" r=".75" fill="currentColor"/>
              </svg>
            </div>
            <div>
              <p className="text-[14px] font-medium text-ink mb-1.5 tracking-[-0.01em]">Ask about your emails</p>
              <p className="text-[12.5px] text-ink-3 leading-relaxed">Summarise, find patterns, or ask<br/>questions about your inbox</p>
            </div>
            {!aiConfigured && (
              <p className="text-[11.5px] text-danger bg-danger/10 px-3 py-2 rounded-xl leading-relaxed">
                Set up an AI provider in <button onClick={() => useEmailStore.getState().setShowAccountModal(true)} className="underline font-semibold hover:text-danger transition-colors">Settings</button> to get started
              </p>
            )}
            <div className="flex flex-col gap-1.5 w-full mt-1">
              {['Summarize my inbox', 'What needs a reply?', 'Any important emails?'].map(q => (
                <button key={q} onClick={() => { setInput(q); inputRef.current?.focus() }}
                  className="text-[12.5px] text-left px-3 py-2 rounded-xl border border-line/60 text-ink-2 hover:border-ai/50 hover:text-ai hover:bg-ai/6 transition-colors">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-6 h-6 rounded-full bg-ai/12 flex items-center justify-center flex-shrink-0 mt-0.5">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="text-ai">
                  <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M5.5 6.5C5.5 5.12 6.62 4 8 4s2.5 1.12 2.5 2.5c0 1.5-1.5 2-2 2.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <circle cx="8" cy="11.5" r=".75" fill="currentColor"/>
                </svg>
              </div>
            )}
            <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap animate-pop
              ${msg.role === 'user'
                ? 'bg-ai text-white rounded-br-md'
                : 'bg-ink/6 text-ink rounded-bl-md'
              }`}>
              {msg.content || (msg.role === 'assistant' && isStreaming && i === messages.length - 1
                ? <span className="inline-flex gap-0.5 items-center h-3">
                    <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '0ms' }}/>
                    <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '150ms' }}/>
                    <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '300ms' }}/>
                  </span>
                : null
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-3 py-3 border-t border-line/40 flex-shrink-0">
        <div className="field flex items-end gap-2 !rounded-2xl px-3 py-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your emails…"
            rows={1}
            disabled={isStreaming}
            className="flex-1 bg-transparent text-[13px] text-ink placeholder-ink-3 resize-none focus:outline-none min-h-[22px] max-h-[96px] overflow-y-auto py-0.5"
            style={{ height: 'auto' }}
            onInput={e => {
              const t = e.currentTarget
              t.style.height = 'auto'
              t.style.height = Math.min(t.scrollHeight, 96) + 'px'
            }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || isStreaming}
            aria-label="Send message"
            className="flex-shrink-0 w-7 h-7 rounded-full bg-ai disabled:opacity-30 flex items-center justify-center transition-all hover:brightness-110 active:scale-90"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M1 11L11 6 1 1v3.5l7 1.5-7 1.5V11z" fill="white"/>
            </svg>
          </button>
        </div>
        <p className="text-[11px] text-ink-3 mt-1.5 text-center">Enter to send · Shift+Enter for a new line</p>
      </div>
    </div>
  )
}
