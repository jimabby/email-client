import { useCallback, useEffect, useMemo, useState } from 'react'
import { pgpApi } from '../api/client'
import { useEmailStore } from '../store/emailStore'
import { confirmDialog, promptDialog } from './DialogHost'
import { useT } from '../lib/i18n'
import type { PgpKeyInfo } from '../types/email'

/** "ABCD 1234 …" — fingerprints are compared by eye, so group them. */
export function formatFingerprint(fp: string) {
  return (fp || '').replace(/(.{4})/g, '$1 ').trim()
}

function saveText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/pgp-keys' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Settings → Encryption. Your own OpenPGP keys (one per address you send
 * from) and the public keys of the people you write to.
 */
export function EncryptionSettings() {
  const t = useT()
  const { accounts, showNotification } = useEmailStore()
  const [identities, setIdentities] = useState<PgpKeyInfo[]>([])
  const [contacts, setContacts] = useState<PgpKeyInfo[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState<string | null>(null) // address being imported for
  const [armored, setArmored] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [contactKey, setContactKey] = useState('')

  const refresh = useCallback(async () => {
    try {
      const keys = await pgpApi.keys()
      setIdentities(keys.identities)
      setContacts(keys.contacts)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  // Every address the user can send from: accounts and their aliases.
  const addresses = useMemo(() => {
    const seen = new Map<string, string>()
    for (const account of accounts) {
      seen.set(account.email.toLowerCase(), account.name || '')
      for (const alias of account.aliases || []) if (alias.email) seen.set(alias.email.toLowerCase(), alias.name || account.name || '')
    }
    return [...seen.entries()].map(([email, name]) => ({ email, name }))
  }, [accounts])

  const errorOf = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error || (e instanceof Error ? e.message : String(e))

  const run = async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true)
    try { await work(); if (success) showNotification('success', success); await refresh() }
    catch (e) { setError(errorOf(e)) }
    finally { setBusy(false) }
  }

  const generate = (email: string, name: string) => run(() => pgpApi.generate(email, name), t('Key created for {email}', { email }))

  const exportPrivate = async (email: string) => {
    const pass = await promptDialog({
      title: t('Back up private key'),
      label: t('Choose a passphrase to protect the backup (8 characters or more). You will need it to import the key anywhere else.'),
      secret: true,
      confirmLabel: t('Export'),
    })
    if (!pass) return
    await run(async () => saveText(`${email}-private.asc`, await pgpApi.exportIdentity(email, pass)), t('Backup saved. Keep it somewhere safe.'))
  }

  const removeIdentity = async (email: string) => {
    const ok = await confirmDialog({
      title: t('Delete the key for {email}?', { email }),
      body: t('Mail encrypted to this key can no longer be opened here. Export a backup first if you might need it.'),
      confirmLabel: t('Delete key'),
      danger: true,
    })
    if (ok) await run(() => pgpApi.removeIdentity(email), t('Key deleted'))
  }

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); showNotification('success', t('Copied')) }
    catch { showNotification('error', t('Could not copy')) }
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-[15px] font-semibold text-ink mb-1 tracking-[-0.01em]">{t('Your keys')}</h3>
        <p className="text-[12.5px] text-ink-3 mb-3 leading-relaxed">
          {t('An OpenPGP key lets you sign what you send and read mail encrypted to you. The private key is stored encrypted on this backend, which uses it to open your mail. If your phone talks to a cloud server, that server can read your encrypted mail.')}
        </p>
        {error && <p role="alert" className="text-[12px] text-danger mb-2">{error}</p>}
        <div className="space-y-2">
          {addresses.map(({ email, name }) => {
            const key = identities.find(k => k.email === email)
            return (
              <div key={email} className="rounded-xl border border-line/50 bg-ink/4 p-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-semibold text-ink truncate">{email}</div>
                    {key ? (
                      <>
                        <div className="text-[11px] text-ink-2 font-mono mt-1 break-all">{formatFingerprint(key.fingerprint)}</div>
                        <div className="text-[10.5px] text-ink-3 mt-0.5">
                          {key.algorithm} · {key.source === 'generated' ? t('Created here') : t('Imported')} · {key.createdAt ? new Date(key.createdAt).toLocaleDateString() : ''}
                        </div>
                      </>
                    ) : (
                      <div className="text-[11px] text-ink-3 mt-0.5">{t('No key yet')}</div>
                    )}
                  </div>
                  <div className="flex flex-wrap justify-end gap-1.5 flex-shrink-0">
                    {key ? (
                      <>
                        <button disabled={busy} onClick={() => key.publicKey && copy(key.publicKey)} className="btn-ghost text-[11px] px-2 py-1 rounded-md">{t('Copy public key')}</button>
                        <button disabled={busy} onClick={() => key.publicKey && saveText(`${email}.asc`, key.publicKey)} className="btn-ghost text-[11px] px-2 py-1 rounded-md">{t('Save public key')}</button>
                        <button disabled={busy} onClick={() => exportPrivate(email)} className="btn-ghost text-[11px] px-2 py-1 rounded-md">{t('Back up')}</button>
                        <button disabled={busy} onClick={() => removeIdentity(email)} className="text-[11px] px-2 py-1 rounded-md text-danger hover:bg-danger/10">{t('Delete')}</button>
                      </>
                    ) : (
                      <>
                        <button disabled={busy} onClick={() => generate(email, name)} className="btn-accent text-[11px] font-semibold px-2.5 py-1 rounded-md">{t('Create key')}</button>
                        <button disabled={busy} onClick={() => { setImporting(email); setArmored(''); setPassphrase('') }} className="btn-ghost text-[11px] px-2 py-1 rounded-md">{t('Import key')}</button>
                      </>
                    )}
                  </div>
                </div>
                {importing === email && !key && (
                  <form
                    className="mt-3 space-y-2"
                    onSubmit={async e => {
                      e.preventDefault()
                      await run(() => pgpApi.importIdentity(email, armored, passphrase || undefined), t('Key imported for {email}', { email }))
                      setImporting(null); setArmored(''); setPassphrase('')
                    }}
                  >
                    <textarea
                      aria-label={t('Private key')}
                      required
                      value={armored}
                      onChange={e => setArmored(e.target.value)}
                      placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                      className="field w-full h-24 px-2.5 py-2 text-[11px] font-mono"
                    />
                    <input
                      aria-label={t('Passphrase')}
                      type="password"
                      autoComplete="off"
                      value={passphrase}
                      onChange={e => setPassphrase(e.target.value)}
                      placeholder={t('Passphrase, if the key has one')}
                      className="field w-full px-2.5 py-1.5 text-[12px]"
                    />
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setImporting(null)} className="btn-ghost text-[11.5px] px-3 py-1.5 rounded-lg">{t('Cancel')}</button>
                      <button disabled={busy} className="btn-accent text-[11.5px] font-semibold px-3 py-1.5 rounded-lg">{t('Import')}</button>
                    </div>
                  </form>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section className="border-t border-line pt-5">
        <h3 className="text-[15px] font-semibold text-ink mb-1 tracking-[-0.01em]">{t('People’s keys')}</h3>
        <p className="text-[12.5px] text-ink-3 mb-3 leading-relaxed">
          {t('To encrypt to someone you need their public key. Paste one below, use “Import key” on a key someone mailed you, or let Hermes pick it up from their signed mail (Autocrypt). Check the fingerprint with them before trusting it.')}
        </p>
        <form
          className="space-y-2 mb-3"
          onSubmit={async e => {
            e.preventDefault()
            await run(async () => {
              const imported = await pgpApi.importContact(contactKey)
              showNotification('success', t('Imported a key for {emails}', { emails: imported.map(i => i.email).join(', ') }))
              setContactKey('')
            })
          }}
        >
          <textarea
            aria-label={t('Public key')}
            required
            value={contactKey}
            onChange={e => setContactKey(e.target.value)}
            placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
            className="field w-full h-20 px-2.5 py-2 text-[11px] font-mono"
          />
          <div className="flex justify-end">
            <button disabled={busy} className="btn-accent text-[11.5px] font-semibold px-3 py-1.5 rounded-lg">{t('Add key')}</button>
          </div>
        </form>
        {contacts.length === 0 && <p className="text-[11.5px] text-ink-3">{t('No keys yet.')}</p>}
        <div className="space-y-1.5">
          {contacts.map(key => (
            <div key={key.email} className="group flex items-start gap-3 rounded-lg px-2.5 py-2 hover:bg-ink/4">
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-ink truncate">{key.email}</div>
                <div className="text-[10.5px] text-ink-3 font-mono break-all">{formatFingerprint(key.fingerprint)}</div>
                <div className="text-[10px] text-ink-3">
                  {key.source === 'autocrypt' ? t('Learned from their mail') : key.source === 'attachment' ? t('Imported from an attachment') : t('Added by you')}
                </div>
                {key.keyChanged && (
                  <div role="alert" className="text-[11px] text-danger mt-1">
                    {t('Their mail now carries a different key ({fingerprint}). Hermes kept the old one. Confirm with them, then delete this entry and import the new key.', { fingerprint: formatFingerprint(key.keyChanged.fingerprint) })}
                  </div>
                )}
              </div>
              <button
                onClick={() => run(() => pgpApi.removeContact(key.email), t('Key removed'))}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-[11px] text-ink-3 hover:text-danger px-1.5"
                aria-label={t('Remove key for {email}', { email: key.email })}
              >
                {t('Remove')}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
