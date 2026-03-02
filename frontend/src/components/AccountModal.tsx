import { useState, useEffect } from 'react'
import { useEmailStore } from '../store/emailStore'
import { accountsApi, aiApi } from '../api/client'
import type { Account } from '../types/email'

type Tab = 'imap' | 'gmail' | 'outlook' | 'ai' | 'signature'

const IMAP_PRESETS: Record<string, { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }> = {
  'Gmail (App Password)': { imapHost: 'imap.gmail.com',        imapPort: 993, smtpHost: 'smtp.gmail.com',        smtpPort: 587 },
  'Outlook/Hotmail':      { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com',    smtpPort: 587 },
  'Yahoo Mail':           { imapHost: 'imap.mail.yahoo.com',   imapPort: 993, smtpHost: 'smtp.mail.yahoo.com',   smtpPort: 587 },
  'iCloud Mail':          { imapHost: 'imap.mail.me.com',      imapPort: 993, smtpHost: 'smtp.mail.me.com',      smtpPort: 587 },
  'Custom':               { imapHost: '',                       imapPort: 993, smtpHost: '',                      smtpPort: 587 },
}

const inputCls = 'w-full px-3 py-2 text-sm bg-[#f6f8fa] dark:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] text-[#1f2328] dark:text-[#e6edf3] placeholder-[#818b98] dark:placeholder-[#484f58] rounded-md focus:outline-none focus:border-[#f59e0b]/60 transition-colors'

export function AccountModal() {
  const { setShowAccountModal, addAccount, showNotification, setAiConfig, aiProvider, aiConfigured, signature, setSignature } = useEmailStore()
  const [tab, setTab]       = useState<Tab>('imap')
  const [preset, setPreset] = useState('Gmail (App Password)')
  const [isLoading, setIsLoading] = useState(false)

  const [form, setForm] = useState({
    email: '', name: '', password: '',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSecure: false,
  })

  const [aiSelectedProvider, setAiSelectedProvider] = useState<'claude' | 'openai' | 'gemini'>(aiProvider || 'claude')
  const [aiApiKey, setAiApiKey] = useState('')
  const [aiSaving, setAiSaving] = useState(false)

  const [signatureText, setSignatureText] = useState(signature)

  useEffect(() => { setAiSelectedProvider(aiProvider || 'claude') }, [aiProvider])

  const update = (field: string, value: string | number | boolean) =>
    setForm(f => ({ ...f, [field]: value }))

  const applyPreset = (name: string) => {
    setPreset(name)
    setForm(f => ({ ...f, ...IMAP_PRESETS[name] }))
  }

  const handleImapSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    try {
      const data = await accountsApi.addImap({
        email: form.email, name: form.name || form.email, password: form.password,
        imapHost: form.imapHost, imapPort: form.imapPort, imapSecure: form.imapSecure,
        smtpHost: form.smtpHost, smtpPort: form.smtpPort, smtpSecure: form.smtpSecure,
      })
      addAccount(data.account as Account)
      showNotification('success', `${form.email} added!`)
      setShowAccountModal(false)
    } catch (err: unknown) {
      showNotification('error', err instanceof Error ? err.message : 'Failed to add account')
    } finally { setIsLoading(false) }
  }

  const handleGmailOAuth = async () => {
    try { const { url } = await accountsApi.getGmailAuthUrl(); window.open(url, '_blank', 'width=500,height=600'); setShowAccountModal(false) }
    catch (err: unknown) { showNotification('error', err instanceof Error ? err.message : 'Failed to start Gmail OAuth') }
  }

  const handleOutlookOAuth = async () => {
    try { const { url } = await accountsApi.getOutlookAuthUrl(); window.open(url, '_blank', 'width=500,height=600'); setShowAccountModal(false) }
    catch (err: unknown) { showNotification('error', err instanceof Error ? err.message : 'Failed to start Outlook OAuth') }
  }

  const handleAiSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!aiApiKey.trim()) { showNotification('error', 'Please enter an API key'); return }
    setAiSaving(true)
    try {
      await aiApi.saveSettings(aiSelectedProvider, aiApiKey)
      setAiConfig(aiSelectedProvider, true)
      setAiApiKey('')
      const name = aiSelectedProvider === 'claude' ? 'Claude' : aiSelectedProvider === 'openai' ? 'ChatGPT' : 'Gemini'
      showNotification('success', `${name} AI configured!`)
    } catch (err: unknown) {
      showNotification('error', err instanceof Error ? err.message : 'Failed to save AI settings')
    } finally { setAiSaving(false) }
  }

  const handleAiClear = async () => {
    try {
      await aiApi.clearSettings()
      setAiConfig(null, false)
      showNotification('success', 'AI settings cleared')
    } catch { showNotification('error', 'Failed to clear AI settings') }
  }

  const handleSignatureSave = () => {
    setSignature(signatureText)
    showNotification('success', 'Signature saved!')
  }

  const tabs = [
    { id: 'imap' as Tab,      label: 'IMAP / SMTP', sub: 'Any provider' },
    { id: 'gmail' as Tab,     label: 'Gmail',        sub: 'OAuth' },
    { id: 'outlook' as Tab,   label: 'Outlook',      sub: 'OAuth' },
    { id: 'ai' as Tab,        label: 'AI',           sub: 'Claude / GPT / Gemini' },
    { id: 'signature' as Tab, label: 'Signature',    sub: 'Email footer' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-[#161b22] border border-[#d0d7de] dark:border-[#30363d] rounded-xl shadow-2xl w-[580px] max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#d0d7de] dark:border-[#30363d]">
          <h2 className="text-base font-semibold text-[#1f2328] dark:text-[#e6edf3]">Settings</h2>
          <button onClick={() => setShowAccountModal(false)} className="text-[#818b98] dark:text-[#484f58] hover:text-[#1f2328] dark:hover:text-[#e6edf3] transition-colors p-1 rounded-md hover:bg-[#eaeef2] dark:hover:bg-[#21262d]">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        {/* Body: left nav + right content */}
        <div className="flex flex-1 min-h-0">
          {/* Left nav */}
          <div className="w-44 flex-shrink-0 border-r border-[#d0d7de] dark:border-[#30363d] bg-[#f6f8fa] dark:bg-[#1c2128] p-2 flex flex-col gap-0.5">
            <div className="text-[9px] font-bold text-[#818b98] dark:text-[#484f58] uppercase tracking-widest px-2 py-1.5">Add Account</div>
            {tabs.filter(t => ['imap','gmail','outlook'].includes(t.id)).map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`w-full flex flex-col items-start px-3 py-2 rounded-lg text-left transition-colors
                  ${tab === t.id
                    ? 'bg-white dark:bg-[#161b22] text-[#1f2328] dark:text-[#e6edf3] shadow-sm border border-[#d0d7de] dark:border-[#30363d]'
                    : 'text-[#656d76] dark:text-[#8b949e] hover:bg-white/60 dark:hover:bg-[#161b22]/60 hover:text-[#1f2328] dark:hover:text-[#e6edf3]'
                  }`}
              >
                <span className="text-xs font-medium">{t.label}</span>
                <span className="text-[10px] opacity-60 mt-0.5">{t.sub}</span>
              </button>
            ))}
            <div className="mt-2 mb-0.5 text-[9px] font-bold text-[#818b98] dark:text-[#484f58] uppercase tracking-widest px-2 py-1.5">Preferences</div>
            {tabs.filter(t => ['ai','signature'].includes(t.id)).map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors
                  ${tab === t.id
                    ? 'bg-white dark:bg-[#161b22] text-[#1f2328] dark:text-[#e6edf3] shadow-sm border border-[#d0d7de] dark:border-[#30363d]'
                    : 'text-[#656d76] dark:text-[#8b949e] hover:bg-white/60 dark:hover:bg-[#161b22]/60 hover:text-[#1f2328] dark:hover:text-[#e6edf3]'
                  }`}
              >
                <span className="text-xs font-medium flex-1">{t.label}</span>
                {t.id === 'ai' && aiConfigured && <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />}
              </button>
            ))}
          </div>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto p-6">
          {tab === 'imap' && (
            <form onSubmit={handleImapSubmit} className="space-y-4">
              <div>
                <label className="block text-[10px] font-semibold text-[#818b98] dark:text-[#484f58] uppercase tracking-wide mb-2">Provider</label>
                <div className="flex flex-wrap gap-1.5">
                  {Object.keys(IMAP_PRESETS).map(p => (
                    <button key={p} type="button" onClick={() => applyPreset(p)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors border
                        ${preset === p
                          ? 'bg-[rgba(245,158,11,0.12)] text-[#b45309] dark:text-[#f59e0b] border-[#f59e0b]/30'
                          : 'bg-[#f6f8fa] dark:bg-[#21262d] text-[#656d76] dark:text-[#8b949e] border-[#d0d7de] dark:border-[#30363d] hover:text-[#1f2328] dark:hover:text-[#e6edf3]'
                        }`}
                    >{p}</button>
                  ))}
                </div>
              </div>

              {preset === 'Gmail (App Password)' && (
                <div className="bg-amber-50 dark:bg-[rgba(245,158,11,0.08)] border border-amber-200 dark:border-[#f59e0b]/20 rounded-md p-3 text-xs text-amber-800 dark:text-[#d97706]">
                  <strong>Gmail App Password required:</strong> Enable 2FA → Google Account → Security → App Passwords → create one and paste it below.
                </div>
              )}

              <div className="space-y-3">
                <div>
                  <label className="block text-[10px] font-semibold text-[#818b98] dark:text-[#484f58] uppercase tracking-wide mb-1">Email Address *</label>
                  <input type="email" required value={form.email} onChange={e => update('email', e.target.value)} className={inputCls} placeholder="you@example.com" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-[#818b98] dark:text-[#484f58] uppercase tracking-wide mb-1">Display Name</label>
                  <input type="text" value={form.name} onChange={e => update('name', e.target.value)} className={inputCls} placeholder="Your Name" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-[#818b98] dark:text-[#484f58] uppercase tracking-wide mb-1">Password / App Password *</label>
                  <input type="password" required value={form.password} onChange={e => update('password', e.target.value)} className={inputCls} placeholder="••••••••••••••••" />
                </div>
              </div>

              <div className="border-t border-[#d0d7de] dark:border-[#30363d] pt-4">
                <p className="text-[10px] font-semibold text-[#656d76] dark:text-[#8b949e] uppercase tracking-wide mb-2">Incoming Mail (IMAP)</p>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <label className="block text-[10px] text-[#818b98] dark:text-[#484f58] mb-1">Host *</label>
                    <input type="text" required value={form.imapHost} onChange={e => update('imapHost', e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#818b98] dark:text-[#484f58] mb-1">Port</label>
                    <input type="number" value={form.imapPort} onChange={e => update('imapPort', parseInt(e.target.value))} className={inputCls} />
                  </div>
                </div>
              </div>

              <div className="border-t border-[#d0d7de] dark:border-[#30363d] pt-4">
                <p className="text-[10px] font-semibold text-[#656d76] dark:text-[#8b949e] uppercase tracking-wide mb-2">Outgoing Mail (SMTP)</p>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <label className="block text-[10px] text-[#818b98] dark:text-[#484f58] mb-1">Host *</label>
                    <input type="text" required value={form.smtpHost} onChange={e => update('smtpHost', e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#818b98] dark:text-[#484f58] mb-1">Port</label>
                    <input type="number" value={form.smtpPort} onChange={e => update('smtpPort', parseInt(e.target.value))} className={inputCls} />
                  </div>
                </div>
              </div>

              <button type="submit" disabled={isLoading}
                className="w-full bg-[#f59e0b] text-[#0d1117] py-2.5 rounded-md text-sm font-bold hover:bg-[#fbbf24] transition-colors disabled:opacity-50">
                {isLoading ? '⟳ Testing connection…' : 'Add Account'}
              </button>
            </form>
          )}

          {tab === 'gmail' && (
            <div className="space-y-4">
              <div className="text-center py-6">
                <div className="w-16 h-16 rounded-full bg-[#f6f8fa] dark:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] flex items-center justify-center mx-auto mb-4">
                  <svg width="32" height="32" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                </div>
                <h3 className="font-semibold text-[#1f2328] dark:text-[#e6edf3] mb-2">Sign in with Google</h3>
                <p className="text-xs text-[#656d76] dark:text-[#8b949e] mb-6 leading-relaxed">Connect your Gmail account using Google OAuth.<br/>You'll be redirected to Google to authorize access.</p>
                <button onClick={handleGmailOAuth}
                  className="flex items-center gap-3 mx-auto bg-white border border-[#d0d7de] text-[#3c4043] px-5 py-2.5 rounded-md text-sm font-semibold hover:bg-[#f6f8fa] transition-colors shadow-sm">
                  <svg width="18" height="18" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  Sign in with Google
                </button>
              </div>
              <div className="bg-[#f6f8fa] dark:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] rounded-md p-3 text-xs text-[#656d76] dark:text-[#8b949e]">
                <strong className="text-[#1f2328] dark:text-[#e6edf3]">Note:</strong> Requires GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in backend .env
              </div>
            </div>
          )}

          {tab === 'outlook' && (
            <div className="space-y-4">
              <div className="text-center py-6">
                <div className="w-16 h-16 rounded-full bg-[#f6f8fa] dark:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] flex items-center justify-center mx-auto mb-4">
                  <svg width="32" height="32" viewBox="0 0 21 21">
                    <rect x="1"  y="1"  width="9" height="9" fill="#f25022"/>
                    <rect x="11" y="1"  width="9" height="9" fill="#7fba00"/>
                    <rect x="1"  y="11" width="9" height="9" fill="#00a4ef"/>
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
                  </svg>
                </div>
                <h3 className="font-semibold text-[#1f2328] dark:text-[#e6edf3] mb-2">Sign in with Microsoft</h3>
                <p className="text-xs text-[#656d76] dark:text-[#8b949e] mb-6 leading-relaxed">Connect your Outlook, Hotmail, or Microsoft 365 account<br/>using Microsoft OAuth.</p>
                <button onClick={handleOutlookOAuth}
                  className="flex items-center gap-3 mx-auto bg-[#0078d4] text-white px-5 py-2.5 rounded-md text-sm font-semibold hover:bg-[#106ebe] transition-colors shadow-sm">
                  <svg width="18" height="18" viewBox="0 0 21 21">
                    <rect x="1"  y="1"  width="9" height="9" fill="white" opacity="0.9"/>
                    <rect x="11" y="1"  width="9" height="9" fill="white" opacity="0.7"/>
                    <rect x="1"  y="11" width="9" height="9" fill="white" opacity="0.7"/>
                    <rect x="11" y="11" width="9" height="9" fill="white" opacity="0.9"/>
                  </svg>
                  Sign in with Microsoft
                </button>
              </div>
              <div className="bg-[#f6f8fa] dark:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] rounded-md p-3 text-xs text-[#656d76] dark:text-[#8b949e]">
                <strong className="text-[#1f2328] dark:text-[#e6edf3]">Note:</strong> Requires OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET in backend .env
              </div>
            </div>
          )}

          {tab === 'signature' && (
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-semibold text-[#818b98] dark:text-[#484f58] uppercase tracking-wide mb-2">
                  Email Signature
                </label>
                <p className="text-xs text-[#656d76] dark:text-[#8b949e] mb-3">
                  This will be automatically appended to new emails (not replies).
                </p>
                <textarea
                  value={signatureText}
                  onChange={e => setSignatureText(e.target.value)}
                  placeholder="Best regards,&#10;Your Name"
                  rows={6}
                  className="w-full px-3 py-2 text-sm bg-[#f6f8fa] dark:bg-[#21262d] border border-[#d0d7de] dark:border-[#30363d] text-[#1f2328] dark:text-[#e6edf3] placeholder-[#818b98] dark:placeholder-[#484f58] rounded-md focus:outline-none focus:border-[#f59e0b]/60 transition-colors resize-none font-sans"
                />
              </div>
              {signatureText !== signature && (
                <div className="text-[10px] text-[#818b98] dark:text-[#484f58]">Unsaved changes</div>
              )}
              <button
                onClick={handleSignatureSave}
                className="w-full bg-[#f59e0b] text-[#0d1117] py-2.5 rounded-md text-sm font-bold hover:bg-[#fbbf24] transition-colors"
              >
                Save Signature
              </button>
              {signature && (
                <button
                  onClick={() => { setSignatureText(''); setSignature(''); showNotification('success', 'Signature cleared') }}
                  className="w-full py-2 rounded-md text-sm text-[#cf222e] dark:text-[#f85149] border border-[#cf222e]/30 dark:border-[#f85149]/30 hover:bg-red-50 dark:hover:bg-[#f85149]/10 transition-colors"
                >
                  Clear Signature
                </button>
              )}
            </div>
          )}

          {tab === 'ai' && (
            <div className="space-y-5">
              {/* Status banner */}
              <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                aiConfigured
                  ? 'bg-green-50 dark:bg-[rgba(46,160,67,0.1)] border-green-200 dark:border-[#238636]'
                  : 'bg-[#f6f8fa] dark:bg-[#21262d] border-[#d0d7de] dark:border-[#30363d]'
              }`}>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${aiConfigured ? 'bg-green-500' : 'bg-[#818b98] dark:bg-[#484f58]'}`} />
                <div className="flex-1 min-w-0">
                  {aiConfigured ? (
                    <>
                      <p className="text-xs font-semibold text-green-700 dark:text-[#3fb950]">
                        {aiProvider === 'claude' ? 'Claude (Anthropic)' : aiProvider === 'openai' ? 'ChatGPT (OpenAI)' : 'Gemini (Google)'} active
                      </p>
                      <p className="text-[11px] text-green-600 dark:text-[#3fb950]/70">AI suggestions are enabled in Compose</p>
                    </>
                  ) : (
                    <>
                      <p className="text-xs font-semibold text-[#656d76] dark:text-[#8b949e]">No AI configured</p>
                      <p className="text-[11px] text-[#818b98] dark:text-[#484f58]">Add an API key below to enable AI suggestions</p>
                    </>
                  )}
                </div>
                {aiConfigured && (
                  <button onClick={handleAiClear} className="text-[11px] text-[#cf222e] dark:text-[#f85149] hover:underline flex-shrink-0">
                    Remove
                  </button>
                )}
              </div>

              {/* Provider cards */}
              <div>
                <label className="block text-[10px] font-semibold text-[#818b98] dark:text-[#484f58] uppercase tracking-wide mb-2">Choose Provider</label>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { id: 'claude',  label: 'Claude',  sub: 'Anthropic', color: '#d97706', letter: 'C' },
                    { id: 'openai',  label: 'ChatGPT', sub: 'OpenAI',    color: '#10a37f', letter: 'AI' },
                    { id: 'gemini',  label: 'Gemini',  sub: 'Google',    color: '#4285F4', letter: 'G' },
                  ] as const).map(p => (
                    <button key={p.id} type="button" onClick={() => setAiSelectedProvider(p.id)}
                      className={`flex flex-col items-center gap-2 p-3 rounded-lg border text-center transition-colors ${
                        aiSelectedProvider === p.id
                          ? 'border-[#f59e0b]/60 bg-[rgba(245,158,11,0.08)]'
                          : 'border-[#d0d7de] dark:border-[#30363d] hover:bg-[#f6f8fa] dark:hover:bg-[#21262d]'
                      }`}
                    >
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-[10px] font-bold" style={{ backgroundColor: p.color }}>{p.letter}</div>
                      <div>
                        <div className="text-xs font-semibold text-[#1f2328] dark:text-[#e6edf3]">{p.label}</div>
                        <div className="text-[10px] text-[#656d76] dark:text-[#8b949e]">{p.sub}</div>
                      </div>
                      {aiSelectedProvider === p.id && (
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <circle cx="7" cy="7" r="6" fill="#f59e0b"/>
                          <path d="M4 7l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* API key */}
              <form onSubmit={handleAiSave} className="space-y-3">
                <div>
                  <label className="block text-[10px] font-semibold text-[#818b98] dark:text-[#484f58] uppercase tracking-wide mb-1">
                    {aiSelectedProvider === 'claude' ? 'Anthropic API Key' : aiSelectedProvider === 'openai' ? 'OpenAI API Key' : 'Google AI API Key'}
                  </label>
                  <input
                    type="password"
                    value={aiApiKey}
                    onChange={e => setAiApiKey(e.target.value)}
                    className={inputCls}
                    placeholder={aiSelectedProvider === 'claude' ? 'sk-ant-api03-…' : aiSelectedProvider === 'openai' ? 'sk-proj-…' : 'AIza…'}
                  />
                  <p className="mt-1.5 text-[10px] text-[#656d76] dark:text-[#8b949e]">
                    {aiSelectedProvider === 'claude'
                      ? 'Get your key at console.anthropic.com → API Keys'
                      : aiSelectedProvider === 'openai'
                      ? 'Get your key at platform.openai.com → API Keys'
                      : 'Get your free key at aistudio.google.com → Get API key'
                    }
                  </p>
                </div>
                <button type="submit" disabled={aiSaving || !aiApiKey.trim()}
                  className="w-full bg-[#f59e0b] text-[#0d1117] py-2.5 rounded-md text-sm font-bold hover:bg-[#fbbf24] transition-colors disabled:opacity-50">
                  {aiSaving ? '⟳ Saving…' : `Save ${aiSelectedProvider === 'claude' ? 'Claude' : aiSelectedProvider === 'openai' ? 'ChatGPT' : 'Gemini'} Key`}
                </button>
              </form>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  )
}
