import { useState, useEffect } from 'react'
import { useEmailStore } from '../store/emailStore'
import { AwaySettings } from './AwaySettings'
import { accountsApi, aiApi, emailsApi } from '../api/client'
import type { Account, Alias, MailTemplate } from '../types/email'

type Tab = 'imap' | 'gmail' | 'outlook' | 'ai' | 'signature' | 'productivity' | 'privacy' | 'away'

const IMAP_PRESETS: Record<string, { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }> = {
  'Gmail (App Password)': { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 587 },
  'Outlook/Hotmail': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'Yahoo Mail': { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 587 },
  'iCloud Mail': { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  'Custom': { imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 587 },
}

const inputCls = 'field w-full px-3 py-2 text-[13.5px]'

/** iOS-style switch. Used by the Privacy panel. */
function Toggle({ checked, onChange, label, hint }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="w-full flex items-center gap-3 text-left rounded-xl px-3 py-2.5 hover:bg-ink/5 transition-colors"
    >
      <span className="flex-1 min-w-0">
        <span className="block text-[13.5px] text-ink">{label}</span>
        {hint && <span className="block text-[12px] text-ink-3 mt-0.5">{hint}</span>}
      </span>
      <span
        className={`relative w-[46px] h-[27px] rounded-full flex-shrink-0 transition-colors duration-200
          ${checked ? 'bg-success' : 'bg-ink/20'}`}
      >
        <span
          className={`absolute top-[2.5px] left-[2.5px] w-[22px] h-[22px] rounded-full bg-white
                      shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform duration-200 ease-spring
            ${checked ? 'translate-x-[19px]' : 'translate-x-0'}`}
        />
      </span>
    </button>
  )
}

export function AccountModal() {
  const {
    setShowAccountModal, addAccount, showNotification, setAiConfig, aiProvider, aiConfigured,
    signature, setSignature, accounts, accountSignatures, setAccountSignature,
    setShowRulesModal, setAliases,
    gravatarEnabled, setGravatarEnabled, theme, toggleTheme,
  } = useEmailStore()
  const [tab, setTab] = useState<Tab>('imap')
  const [preset, setPreset] = useState('Gmail (App Password)')
  const [isLoading, setIsLoading] = useState(false)

  const [form, setForm] = useState({
    email: '', name: '', password: '',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSecure: false,
    allowInsecureTLS: false,
  })

  const [aliasAccountId, setAliasAccountId] = useState(accounts[0]?.id || '')
  const [aliasList, setAliasList] = useState<Alias[]>([])

  const [aiSelectedProvider, setAiSelectedProvider] = useState<'claude' | 'openai' | 'gemini'>(aiProvider || 'claude')
  const [aiApiKey, setAiApiKey] = useState('')
  const [aiSaving, setAiSaving] = useState(false)

  const [signatureText, setSignatureText] = useState(signature)
  const [templates, setTemplates] = useState<MailTemplate[]>([])

  useEffect(() => { setAiSelectedProvider(aiProvider || 'claude') }, [aiProvider])
  useEffect(() => { emailsApi.getTemplates().then(setTemplates).catch(() => {}) }, [])

  useEffect(() => {
    if (!aliasAccountId) return
    emailsApi.getAliases(aliasAccountId)
      .then(list => { setAliasList(list); setAliases(aliasAccountId, list) })
      .catch(() => setAliasList([]))
  }, [aliasAccountId])

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
        allowInsecureTLS: form.allowInsecureTLS,
      })
      addAccount(data.account as Account)
      showNotification('success', `${form.email} added!`)
      setShowAccountModal(false)
    } catch (err: unknown) {
      const msg = (err as any)?.response?.data?.error
        || (err instanceof Error ? err.message : 'Failed to add account')
      showNotification('error', msg)
    } finally { setIsLoading(false) }
  }

  const handleGmailOAuth = async () => {
    try { const { url } = await accountsApi.getGmailAuthUrl(); window.open(url, '_blank', 'width=500,height=600'); setShowAccountModal(false) }
    catch (err: unknown) { showNotification('error', (err as any)?.response?.data?.error || (err instanceof Error ? err.message : 'Failed to start Gmail OAuth')) }
  }

  const handleOutlookOAuth = async () => {
    try { const { url } = await accountsApi.getOutlookAuthUrl(); window.open(url, '_blank', 'width=500,height=600'); setShowAccountModal(false) }
    catch (err: unknown) { showNotification('error', (err as any)?.response?.data?.error || (err instanceof Error ? err.message : 'Failed to start Outlook OAuth')) }
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
    { id: 'imap' as Tab, label: 'IMAP / SMTP', sub: 'Any provider' },
    { id: 'gmail' as Tab, label: 'Gmail', sub: 'OAuth' },
    { id: 'outlook' as Tab, label: 'Outlook', sub: 'OAuth' },
    { id: 'ai' as Tab, label: 'AI', sub: 'Claude / GPT / Gemini' },
    { id: 'signature' as Tab, label: 'Signature', sub: 'Email footer' },
    { id: 'productivity' as Tab, label: 'Rules & Templates', sub: 'Automate mail' },
    { id: 'privacy' as Tab, label: 'Privacy & Appearance', sub: 'Tracking, theme' },
    { id: 'away' as Tab, label: 'Away & Export', sub: 'Auto-reply, backup' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-md p-4 animate-fade">
      <div className="glass-elevated rounded-3xl w-[600px] max-h-[90vh] flex flex-col overflow-hidden animate-rise">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line ">
          <h2 className="text-base font-semibold text-ink ">Settings</h2>
          <button onClick={() => setShowAccountModal(false)} className="btn-ghost w-8 h-8 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        {/* Body: left nav + right content */}
        <div className="flex flex-1 min-h-0">
          {/* Left nav */}
          <div className="w-44 flex-shrink-0 border-r border-line/40 p-2 flex flex-col gap-0.5">
            <div className="text-[9px] font-bold text-ink-3 uppercase tracking-widest px-2 py-1.5">Add Account</div>
            {tabs.filter(t => ['imap','gmail','outlook'].includes(t.id)).map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`w-full flex flex-col items-start px-3 py-2 rounded-lg text-left transition-colors
                  ${tab === t.id
                    ? 'bg-ink/8 text-ink font-medium'
                    : 'text-ink-2 hover:bg-ink/5 hover:text-ink'
                  }`}
              >
                <span className="text-xs font-medium">{t.label}</span>
                <span className="text-[10px] opacity-60 mt-0.5">{t.sub}</span>
              </button>
            ))}
            <div className="mt-2 mb-0.5 text-[10px] font-semibold text-ink-3 uppercase tracking-[0.08em] px-2 py-1.5">Preferences</div>
            {tabs.filter(t => ['ai','signature','productivity','privacy','away'].includes(t.id)).map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors
                  ${tab === t.id
                    ? 'bg-ink/8 text-ink font-medium'
                    : 'text-ink-2 hover:bg-ink/5 hover:text-ink'
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
                <label className="block text-[10px] font-semibold text-ink-3 uppercase tracking-wide mb-2">Provider</label>
                <div className="flex flex-wrap gap-1.5">
                  {Object.keys(IMAP_PRESETS).map(p => (
                    <button key={p} type="button" onClick={() => applyPreset(p)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors border
                        ${preset === p
                          ? 'bg-accent/12 text-accent-ink border-accent/30'
                          : 'bg-surface-2 text-ink-2 border-line hover:text-ink '
                        }`}
                    >{p}</button>
                  ))}
                </div>
              </div>

              {preset === 'Gmail (App Password)' && (
                <div className="bg-accent/10 border border-accent/25 rounded-xl p-3 text-[12.5px] text-accent-ink leading-relaxed">
                  <strong>Gmail App Password required:</strong> Enable 2FA → Google Account → Security → App Passwords → create one and paste it below.
                </div>
              )}

              <div className="space-y-3">
                <div>
                  <label className="block text-[10px] font-semibold text-ink-3 uppercase tracking-wide mb-1">Email Address *</label>
                  <input type="email" required value={form.email} onChange={e => update('email', e.target.value)} className={inputCls} placeholder="you@example.com" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-ink-3 uppercase tracking-wide mb-1">Display Name</label>
                  <input type="text" value={form.name} onChange={e => update('name', e.target.value)} className={inputCls} placeholder="Your Name" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-ink-3 uppercase tracking-wide mb-1">Password / App Password *</label>
                  <input type="password" required value={form.password} onChange={e => update('password', e.target.value)} className={inputCls} placeholder="••••••••••••••••" />
                </div>
              </div>

              <div className="border-t border-line pt-4">
                <p className="text-[10px] font-semibold text-ink-2 uppercase tracking-wide mb-2">Incoming Mail (IMAP)</p>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <label className="block text-[10px] text-ink-3 mb-1">Host *</label>
                    <input type="text" required value={form.imapHost} onChange={e => update('imapHost', e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-ink-3 mb-1">Port</label>
                    <input type="number" value={form.imapPort} onChange={e => update('imapPort', parseInt(e.target.value))} className={inputCls} />
                  </div>
                </div>
              </div>

              <div className="border-t border-line pt-4">
                <p className="text-[10px] font-semibold text-ink-2 uppercase tracking-wide mb-2">Outgoing Mail (SMTP)</p>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <label className="block text-[10px] text-ink-3 mb-1">Host *</label>
                    <input type="text" required value={form.smtpHost} onChange={e => update('smtpHost', e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-[10px] text-ink-3 mb-1">Port</label>
                    <input type="number" value={form.smtpPort} onChange={e => update('smtpPort', parseInt(e.target.value))} className={inputCls} />
                  </div>
                </div>
              </div>

              <label className="flex items-start gap-2 text-[11px] text-ink-2 ">
                <input
                  type="checkbox"
                  checked={form.allowInsecureTLS}
                  onChange={e => update('allowInsecureTLS', e.target.checked)}
                  className="accent-danger mt-0.5"
                />
                <span>
                  Accept self-signed certificates
                  <span className="block text-[10px] text-danger ">
                    Only for a server you control. This disables certificate checks, so anyone able to
                    intercept the connection can read your password and your mail.
                  </span>
                </span>
              </label>

              <button type="submit" disabled={isLoading}
                className="w-full bg-accent text-[#201500] py-2.5 rounded-md text-sm font-bold hover:bg-accent transition-colors disabled:opacity-50">
                {isLoading ? '⟳ Testing connection…' : 'Add Account'}
              </button>
            </form>
          )}

          {tab === 'gmail' && (
            <div className="space-y-4">
              <div className="text-center py-6">
                <div className="w-16 h-16 rounded-full bg-surface-2 border border-line flex items-center justify-center mx-auto mb-4">
                  <svg width="32" height="32" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                </div>
                <h3 className="font-semibold text-ink mb-2">Sign in with Google</h3>
                <p className="text-xs text-ink-2 mb-6 leading-relaxed">Connect your Gmail account using Google OAuth.<br/>You'll be redirected to Google to authorize access.</p>
                <button onClick={handleGmailOAuth}
                  className="flex items-center gap-3 mx-auto bg-white border border-line text-ink px-5 py-2.5 rounded-md text-sm font-semibold hover:bg-surface-2 transition-colors shadow-sm">
                  <svg width="18" height="18" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  Sign in with Google
                </button>
              </div>
              <div className="bg-surface-2 border border-line rounded-md p-3 text-xs text-ink-2 ">
                <strong className="text-ink ">Note:</strong> Requires GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in backend .env
              </div>
            </div>
          )}

          {tab === 'outlook' && (
            <div className="space-y-4">
              <div className="text-center py-6">
                <div className="w-16 h-16 rounded-full bg-surface-2 border border-line flex items-center justify-center mx-auto mb-4">
                  <svg width="32" height="32" viewBox="0 0 21 21">
                    <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
                  </svg>
                </div>
                <h3 className="font-semibold text-ink mb-2">Sign in with Microsoft</h3>
                <p className="text-xs text-ink-2 mb-6 leading-relaxed">Connect your Outlook, Hotmail, or Microsoft 365 account<br/>using Microsoft OAuth.</p>
                <button onClick={handleOutlookOAuth}
                  className="flex items-center gap-3 mx-auto bg-[#0078d4] text-white px-5 py-2.5 rounded-md text-sm font-semibold hover:bg-[#106ebe] transition-colors shadow-sm">
                  <svg width="18" height="18" viewBox="0 0 21 21">
                    <rect x="1" y="1" width="9" height="9" fill="white" opacity="0.9"/>
                    <rect x="11" y="1" width="9" height="9" fill="white" opacity="0.7"/>
                    <rect x="1" y="11" width="9" height="9" fill="white" opacity="0.7"/>
                    <rect x="11" y="11" width="9" height="9" fill="white" opacity="0.9"/>
                  </svg>
                  Sign in with Microsoft
                </button>
              </div>
              <div className="bg-surface-2 border border-line rounded-md p-3 text-xs text-ink-2 ">
                <strong className="text-ink ">Note:</strong> Requires OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET in backend .env
              </div>
            </div>
          )}

          {tab === 'away' && <AwaySettings />}

          {tab === 'signature' && (
            <div className="space-y-5">
              {/* Default signature */}
              <div>
                <label className="block text-[10px] font-semibold text-ink-3 uppercase tracking-wide mb-2">
                  Default Signature
                </label>
                <p className="text-xs text-ink-2 mb-3">
                  Used for all accounts unless overridden below.
                </p>
                <textarea
                  value={signatureText}
                  onChange={e => setSignatureText(e.target.value)}
                  placeholder="Best regards,&#10;Your Name"
                  rows={4}
                  className="w-full px-3 py-2 text-sm bg-surface-2 border border-line text-ink placeholder-ink-3 rounded-md focus:outline-none focus:border-accent/60 transition-colors resize-none font-sans"
                />
                {signatureText !== signature && (
                  <div className="flex items-center gap-2 mt-2">
                    <div className="text-[10px] text-ink-3 ">Unsaved changes</div>
                    <button
                      onClick={handleSignatureSave}
                      className="px-3 py-1 text-xs font-semibold bg-accent text-[#201500] rounded-md hover:bg-accent transition-colors"
                    >
                      Save
                    </button>
                  </div>
                )}
                {signature && signatureText === signature && (
                  <button
                    onClick={() => { setSignatureText(''); setSignature(''); showNotification('success', 'Default signature cleared') }}
                    className="mt-2 text-xs text-danger hover:underline"
                  >
                    Clear default signature
                  </button>
                )}
              </div>

              {/* Per-account signatures */}
              {accounts.length > 0 && (
                <div>
                  <label className="block text-[10px] font-semibold text-ink-3 uppercase tracking-wide mb-2">
                    Per-Account Signatures
                  </label>
                  <p className="text-xs text-ink-2 mb-3">
                    Override the default signature for specific accounts.
                  </p>
                  <div className="space-y-3">
                    {accounts.map(acc => (
                      <div key={acc.id} className="border border-line rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white ${acc.type === 'gmail' ? 'bg-red-500' : acc.type === 'outlook' ? 'bg-blue-500' : 'bg-amber-500'}`}>
                            {(acc.name || acc.email).slice(0, 2).toUpperCase()}
                          </div>
                          <span className="text-xs font-medium text-ink truncate">{acc.email}</span>
                          {accountSignatures[acc.id] && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent-ink ">custom</span>
                          )}
                        </div>
                        <textarea
                          value={accountSignatures[acc.id] ?? ''}
                          onChange={e => setAccountSignature(acc.id, e.target.value)}
                          placeholder={signature ? `Using default: "${signature.slice(0, 40)}..."` : 'Uses default signature'}
                          rows={3}
                          className="w-full px-3 py-2 text-xs bg-surface-2 border border-line text-ink placeholder-ink-3 rounded-md focus:outline-none focus:border-accent/60 transition-colors resize-none font-sans"
                        />
                        {accountSignatures[acc.id] && (
                          <button
                            onClick={() => { setAccountSignature(acc.id, ''); showNotification('success', `Signature for ${acc.email} cleared — using default`) }}
                            className="mt-1 text-[10px] text-danger hover:underline"
                          >
                            Use default instead
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'ai' && (
            <div className="space-y-5">
              {/* Status banner */}
              <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                aiConfigured
                  ? 'bg-success/10 border-success/30'
                  : 'bg-surface-2 border-line '
              }`}>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${aiConfigured ? 'bg-green-500' : 'bg-ink-3 '}`} />
                <div className="flex-1 min-w-0">
                  {aiConfigured ? (
                    <>
                      <p className="text-xs font-semibold text-green-700 ">
                        {aiProvider === 'claude' ? 'Claude (Anthropic)' : aiProvider === 'openai' ? 'ChatGPT (OpenAI)' : 'Gemini (Google)'} active
                      </p>
                      <p className="text-[11px] text-green-600 ">AI suggestions are enabled in Compose</p>
                    </>
                  ) : (
                    <>
                      <p className="text-xs font-semibold text-ink-2 ">No AI configured</p>
                      <p className="text-[11px] text-ink-3 ">Add an API key below to enable AI suggestions</p>
                    </>
                  )}
                </div>
                {aiConfigured && (
                  <button onClick={handleAiClear} className="text-[11px] text-danger hover:underline flex-shrink-0">
                    Remove
                  </button>
                )}
              </div>

              {/* Provider cards */}
              <div>
                <label className="block text-[10px] font-semibold text-ink-3 uppercase tracking-wide mb-2">Choose Provider</label>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { id: 'claude', label: 'Claude', sub: 'Anthropic', color: '#d97706', letter: 'C' },
                    { id: 'openai', label: 'ChatGPT', sub: 'OpenAI', color: '#10a37f', letter: 'AI' },
                    { id: 'gemini', label: 'Gemini', sub: 'Google', color: '#4285F4', letter: 'G' },
                  ] as const).map(p => (
                    <button key={p.id} type="button" onClick={() => setAiSelectedProvider(p.id)}
                      className={`flex flex-col items-center gap-2 p-3 rounded-lg border text-center transition-colors ${
                        aiSelectedProvider === p.id
                          ? 'border-accent/60 bg-accent/10'
                          : 'border-line hover:bg-surface-2 '
                      }`}
                    >
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-[10px] font-bold" style={{ backgroundColor: p.color }}>{p.letter}</div>
                      <div>
                        <div className="text-xs font-semibold text-ink ">{p.label}</div>
                        <div className="text-[10px] text-ink-2 ">{p.sub}</div>
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
                  <label className="block text-[10px] font-semibold text-ink-3 uppercase tracking-wide mb-1">
                    {aiSelectedProvider === 'claude' ? 'Anthropic API Key' : aiSelectedProvider === 'openai' ? 'OpenAI API Key' : 'Google AI API Key'}
                  </label>
                  <input
                    type="password"
                    value={aiApiKey}
                    onChange={e => setAiApiKey(e.target.value)}
                    className={inputCls}
                    placeholder={aiSelectedProvider === 'claude' ? 'sk-ant-api03-…' : aiSelectedProvider === 'openai' ? 'sk-proj-…' : 'AIza…'}
                  />
                  <p className="mt-1.5 text-[10px] text-ink-2 ">
                    {aiSelectedProvider === 'claude'
                      ? 'Get your key at console.anthropic.com → API Keys'
                      : aiSelectedProvider === 'openai'
                      ? 'Get your key at platform.openai.com → API Keys'
                      : 'Get your free key at aistudio.google.com → Get API key'
                    }
                  </p>
                </div>
                <button type="submit" disabled={aiSaving || !aiApiKey.trim()}
                  className="w-full bg-accent text-[#201500] py-2.5 rounded-md text-sm font-bold hover:bg-accent transition-colors disabled:opacity-50">
                  {aiSaving ? '⟳ Saving…' : `Save ${aiSelectedProvider === 'claude' ? 'Claude' : aiSelectedProvider === 'openai' ? 'ChatGPT' : 'Gemini'} Key`}
                </button>
              </form>
            </div>
          )}
          {tab === 'privacy' && (
            <div className="space-y-6">
              <section>
                <h3 className="text-[15px] font-semibold text-ink mb-1 tracking-[-0.01em]">Contact pictures</h3>
                <p className="text-[12.5px] text-ink-3 mb-4 leading-relaxed">
                  Hermes shows coloured initials by default. Fetching a real picture asks
                  gravatar.com for it, which tells that service the address of every person who
                  writes to you — the same disclosure the reader blocks remote images to prevent.
                </p>
                <Toggle
                  checked={gravatarEnabled}
                  onChange={setGravatarEnabled}
                  label="Load contact pictures from Gravatar"
                  hint={gravatarEnabled ? 'Sender addresses are sent (hashed) to gravatar.com' : 'Nothing leaves this machine'}
                />
              </section>

              <section className="border-t border-line/40 pt-5">
                <h3 className="text-[15px] font-semibold text-ink mb-1 tracking-[-0.01em]">Appearance</h3>
                <p className="text-[12.5px] text-ink-3 mb-4 leading-relaxed">
                  Also available from the moon icon in the title bar.
                </p>
                <Toggle
                  checked={theme === 'dark'}
                  onChange={() => toggleTheme()}
                  label="Dark appearance"
                  hint={theme === 'dark' ? 'Dark' : 'Light'}
                />
              </section>
            </div>
          )}

          {tab === 'productivity' && (
            <div className="space-y-6">
              <section>
                <h3 className="text-sm font-semibold text-ink mb-1">Mailbox rules</h3>
                <p className="text-[11px] text-ink-3 mb-3">
                  Rules run on the server as mail arrives, with multiple conditions and actions per rule.
                </p>
                <button
                  onClick={() => { setShowAccountModal(false); setShowRulesModal(true) }}
                  className="px-3 py-2 rounded-md bg-accent text-xs font-bold text-[#201500] hover:bg-accent transition-colors"
                >
                  Open rules editor
                </button>
              </section>

              <section className="border-t border-line pt-5">
                <h3 className="text-sm font-semibold text-ink mb-1">Send-as addresses</h3>
                <p className="text-[11px] text-ink-3 mb-3">
                  Extra identities you can pick in the From field. The address must already be authorised
                  with your provider, or it will reject the message.
                </p>
                <select
                  value={aliasAccountId}
                  onChange={e => setAliasAccountId(e.target.value)}
                  className={`${inputCls} mb-3`}
                  aria-label="Account for aliases"
                >
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}
                </select>
                <div className="space-y-2">
                  {aliasList.map((alias, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={alias.email}
                        placeholder="alias@example.com"
                        onChange={e => setAliasList(list => list.map((x, j) => j === i ? { ...x, email: e.target.value } : x))}
                        className={inputCls}
                      />
                      <input
                        value={alias.name || ''}
                        placeholder="Display name"
                        onChange={e => setAliasList(list => list.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                        className={inputCls}
                      />
                      <label className="flex items-center gap-1 text-[10px] text-ink-2 whitespace-nowrap">
                        <input
                          type="radio"
                          name="default-alias"
                          checked={!!alias.isDefault}
                          onChange={() => setAliasList(list => list.map((x, j) => ({ ...x, isDefault: j === i })))}
                          className="accent-accent"
                        />
                        Default
                      </label>
                      <button onClick={() => setAliasList(list => list.filter((_, j) => j !== i))} className="text-xs text-danger">×</button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => setAliasList(list => [...list, { email: '', name: '' }])} className="text-xs text-info">+ Add address</button>
                  <div className="flex-1" />
                  <button
                    onClick={async () => {
                      try {
                        const saved = await emailsApi.saveAliases(aliasAccountId, aliasList.filter(a => a.email.trim()))
                        setAliasList(saved)
                        setAliases(aliasAccountId, saved)
                        showNotification('success', 'Send-as addresses saved')
                      } catch (err) {
                        showNotification('error', err instanceof Error ? err.message : 'Could not save addresses')
                      }
                    }}
                    disabled={!aliasAccountId}
                    className="px-3 py-2 rounded-md bg-accent text-xs font-bold text-[#201500] disabled:opacity-50"
                  >
                    Save addresses
                  </button>
                </div>
              </section>

              <section className="border-t border-line pt-5">
                <div className="flex items-center justify-between mb-3"><h3 className="text-sm font-semibold text-ink ">Templates</h3><button onClick={() => setTemplates(t => [...t, { id: crypto.randomUUID(), name: 'New template', subject: '', body: '' }])} className="text-xs text-info">+ Add template</button></div>
                <div className="space-y-2">{templates.map((template, i) => <div key={template.id} className="rounded-lg border border-line p-3 space-y-2"><div className="flex gap-2"><input value={template.name} onChange={e => setTemplates(t => t.map((x,j) => j === i ? {...x,name:e.target.value} : x))} className={inputCls}/><button onClick={() => setTemplates(t => t.filter(x => x.id !== template.id))} className="text-xs text-danger">Remove</button></div><input value={template.subject} placeholder="Subject" onChange={e => setTemplates(t => t.map((x,j) => j === i ? {...x,subject:e.target.value} : x))} className={inputCls}/><textarea rows={3} value={template.body} placeholder="Message body" onChange={e => setTemplates(t => t.map((x,j) => j === i ? {...x,body:e.target.value} : x))} className={inputCls}/></div>)}</div>
                <button onClick={async () => { const saved = await emailsApi.saveTemplates(templates); setTemplates(saved); showNotification('success','Templates saved') }} className="mt-3 px-3 py-2 rounded-md bg-accent text-xs font-bold text-[#201500]">Save templates</button>
              </section>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  )
}
