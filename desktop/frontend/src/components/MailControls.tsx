import { useEffect, useState } from 'react'
import { aiApi, emailsApi, recoveryApi } from '../api/client'
import { useEmailStore } from '../store/emailStore'
import type { Folder } from '../types/email'

export function MailControls() {
  const accounts = useEmailStore(s => s.accounts)
  const [accountId, setAccountId] = useState(accounts[0]?.id || '')
  const [folders, setFolders] = useState<Folder[]>([])
  const [folder, setFolder] = useState('INBOX')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [coverage, setCoverage] = useState<any>(null)
  const [privacy, setPrivacy] = useState<{ localOnly: boolean; automaticAccounts: string[] } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { aiApi.privacy().then(setPrivacy).catch(e => setError(String(e))) }, [])
  useEffect(() => { if (accountId) emailsApi.getFolders(accountId).then(setFolders).catch(e => setError(String(e))) }, [accountId])
  useEffect(() => {
    const refresh = () => recoveryApi.coverage().then(setCoverage).catch(e => setError(String(e)))
    refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer)
  }, [])
  const savePrivacy = async (next: NonNullable<typeof privacy>) => {
    try { await aiApi.savePrivacy(next); setPrivacy(next); setError('') } catch (e) { setError(String(e)) }
  }
  return <section className="space-y-3 border-t border-line pt-4">
    <h3>AI privacy</h3>
    <p className="text-xs">Local-only mode blocks external AI requests for this backend. Manual draft assistance previews the text before sending. Automatic completion sends the current subject and draft after a typing pause only for opted-in accounts.</p>
    {privacy && <>
      <label className="block"><input type="checkbox" checked={privacy.localOnly} onChange={e => savePrivacy({ ...privacy, localOnly: e.target.checked })} /> Local-only mode</label>
      {accounts.map(account => <label key={account.id} className="block"><input type="checkbox" disabled={privacy.localOnly} checked={privacy.automaticAccounts.includes(account.id)} onChange={e => savePrivacy({ ...privacy, automaticAccounts: e.target.checked ? [...privacy.automaticAccounts, account.id] : privacy.automaticAccounts.filter(id => id !== account.id) })} /> Automatic completion for {account.email}</label>)}
    </>}
    <h3>Search coverage</h3>
    <p className="text-xs">Coverage describes locally retained messages, not every message on the provider. Backfill fetches message bodies in the selected range. The index retains up to {coverage?.limit || 50000} messages; older entries may be evicted.</p>
    {coverage?.folders?.map((item: any) => <p key={item.accountId + item.folder} className="text-xs">{accounts.find(a => a.id === item.accountId)?.email} / {item.folder}: {item.messages} summaries, {item.bodies} bodies; {item.oldest?.slice(0, 10)} — {item.newest?.slice(0, 10)}</p>)}
    <select aria-label="Backfill account" className="field" value={accountId} onChange={e => { setAccountId(e.target.value); setFolder('INBOX') }}>{accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}</select>
    <select aria-label="Backfill folder" className="field" value={folder} onChange={e => setFolder(e.target.value)}><option value="INBOX">INBOX</option>{folders.filter(f => f.path !== 'INBOX').map(f => <option key={f.path} value={f.path}>{f.name}</option>)}</select>
    <label className="block">From <input aria-label="Backfill from" type="date" className="field" value={since} onChange={e => setSince(e.target.value)} /></label>
    <label className="block">Through <input aria-label="Backfill through" type="date" className="field" value={until} onChange={e => setUntil(e.target.value)} /></label>
    <button disabled={!accountId || coverage?.jobs?.some((j: any) => j.accountId === accountId && j.running)} onClick={async () => { try { await recoveryApi.backfill({ accountId, folder, since, until }); setCoverage(await recoveryApi.coverage()); setError('') } catch (e) { setError(String(e)) } }} className="text-info">Backfill selected range</button>
    {coverage?.jobs?.map((job: any) => <p key={job.accountId} role="status">{job.folder}: {job.running ? 'Running' : job.error ? 'Stopped' : 'Finished'} — {job.indexed} bodies indexed / {job.scanned} checked. {job.error}</p>)}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </section>
}
