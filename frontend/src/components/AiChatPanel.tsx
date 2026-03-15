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

    const controller = await streamAiChat(
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
    controllerRef.current = controller
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
    <div className="flex flex-col h-full bg-white dark:bg-[#0d1117] border-l border-[#d0d7de] dark:border-[#30363d]">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-[#d0d7de] dark:border-[#30363d] flex items-center gap-2 bg-[#f6f8fa] dark:bg-[#161b22] flex-shrink-0">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-[#7c3aed]">
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M5.5 6.5C5.5 5.12 6.62 4 8 4s2.5 1.12 2.5 2.5c0 1.5-1.5 2-2 2.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          <circle cx="8" cy="11.5" r=".75" fill="currentColor"/>
        </svg>
        <span className="text-xs font-semibold text-[#1f2328] dark:text-[#e6edf3] flex-1">AI Assistant</span>
        {messages.length > 0 && (
          <button onClick={clear} title="Clear chat"
            className="text-[#818b98] dark:text-[#484f58] hover:text-[#cf222e] dark:hover:text-[#f85149] p-1 rounded transition-colors">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 pb-8">
            <div className="w-10 h-10 rounded-full bg-[#f3f0ff] dark:bg-[#7c3aed]/20 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" className="text-[#7c3aed]">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M5.5 6.5C5.5 5.12 6.62 4 8 4s2.5 1.12 2.5 2.5c0 1.5-1.5 2-2 2.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                <circle cx="8" cy="11.5" r=".75" fill="currentColor"/>
              </svg>
            </div>
            <div>
              <p className="text-xs font-medium text-[#1f2328] dark:text-[#e6edf3] mb-1">Ask me about your emails</p>
              <p className="text-[11px] text-[#818b98] dark:text-[#484f58]">Summarize, find patterns, or ask<br/>questions about your inbox</p>
            </div>
            {!aiConfigured && (
              <p className="text-[10px] text-[#cf222e] dark:text-[#f85149] bg-[#ffeef0] dark:bg-[#f85149]/10 px-2.5 py-1.5 rounded-md">
                Set up an AI provider in <button onClick={() => useEmailStore.getState().setShowAccountModal(true)} className="underline font-semibold hover:text-[#a40e26] dark:hover:text-[#ff7b72] transition-colors">Settings</button> to get started
              </p>
            )}
            <div className="flex flex-col gap-1.5 w-full mt-1">
              {['Summarize my inbox', 'What needs a reply?', 'Any important emails?'].map(q => (
                <button key={q} onClick={() => { setInput(q); inputRef.current?.focus() }}
                  className="text-[11px] text-left px-2.5 py-1.5 rounded-lg border border-[#d0d7de] dark:border-[#30363d] text-[#656d76] dark:text-[#8b949e] hover:border-[#7c3aed] hover:text-[#7c3aed] transition-colors">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-5 h-5 rounded-full bg-[#f3f0ff] dark:bg-[#7c3aed]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="text-[#7c3aed]">
                  <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M5.5 6.5C5.5 5.12 6.62 4 8 4s2.5 1.12 2.5 2.5c0 1.5-1.5 2-2 2.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <circle cx="8" cy="11.5" r=".75" fill="currentColor"/>
                </svg>
              </div>
            )}
            <div className={`max-w-[85%] px-2.5 py-2 rounded-xl text-[11.5px] leading-relaxed whitespace-pre-wrap
              ${msg.role === 'user'
                ? 'bg-[#7c3aed] text-white rounded-tr-sm'
                : 'bg-[#f6f8fa] dark:bg-[#161b22] text-[#1f2328] dark:text-[#e6edf3] rounded-tl-sm'
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
      <div className="px-3 py-2.5 border-t border-[#d0d7de] dark:border-[#30363d] flex-shrink-0">
        <div className="flex items-end gap-2 bg-[#f6f8fa] dark:bg-[#161b22] rounded-xl border border-[#d0d7de] dark:border-[#30363d] px-3 py-2 focus-within:border-[#7c3aed] transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your emails…"
            rows={1}
            disabled={isStreaming}
            className="flex-1 bg-transparent text-xs text-[#1f2328] dark:text-[#e6edf3] placeholder-[#818b98] dark:placeholder-[#484f58] resize-none focus:outline-none min-h-[20px] max-h-[80px] overflow-y-auto"
            style={{ height: 'auto' }}
            onInput={e => {
              const t = e.currentTarget
              t.style.height = 'auto'
              t.style.height = Math.min(t.scrollHeight, 80) + 'px'
            }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || isStreaming}
            aria-label="Send message"
            className="flex-shrink-0 w-6 h-6 rounded-lg bg-[#7c3aed] disabled:opacity-40 flex items-center justify-center transition-opacity hover:bg-[#6d28d9]"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M1 11L11 6 1 1v3.5l7 1.5-7 1.5V11z" fill="white"/>
            </svg>
          </button>
        </div>
        <p className="text-[10px] text-[#818b98] dark:text-[#484f58] mt-1 text-center">Enter to send · Shift+Enter for new line</p>
      </div>
    </div>
  )
}
