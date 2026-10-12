import { useEffect, useState, type ReactNode } from 'react'
import { initializePrivateStorage, readPrivate } from '../lib/privateStorage'
import { useEmailStore } from '../store/emailStore'
import { useT } from '../lib/i18n'
export function PrivateStorageGate({ children }: { children: ReactNode }) {
  const t = useT(); const [ready, setReady] = useState(false); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const unlock = async (passphrase?: string) => {
    setBusy(true)
    try { await initializePrivateStorage(passphrase); useEmailStore.setState({ drafts: readPrivate('hermes-drafts', []) }); setPassword(''); setReady(true) }
    catch { setError(t('Could not unlock private storage. Check your passphrase or system keychain. Existing data has been kept.')) }
    finally { setBusy(false) }
  }
  useEffect(() => { if (window.hermes?.privateKey) unlock() }, [])
  if (ready) return <>{children}</>
  return <div className="min-h-screen flex items-center justify-center"><form className="space-y-4 max-w-md p-8" onSubmit={e => { e.preventDefault(); unlock(password) }}>
    <h1>{t('Unlock local drafts and outbox')}</h1>
    {!window.hermes?.privateKey && <><p>{t('Choose a storage passphrase on first use, or enter your existing one. It encrypts mail saved in this browser and is never sent to the server. Keep it safe: forgotten passphrases cannot be recovered.')}</p><input aria-label="Storage passphrase" type="password" minLength={12} required autoComplete="off" className="field w-full" value={password} onChange={e => setPassword(e.target.value)} /></>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    <button className="text-info" disabled={busy}>{busy ? t('Unlocking?') : t('Unlock')}</button>
  </form></div>
}
