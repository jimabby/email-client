import { useEffect, useState } from 'react'
import { recoveryApi, type SyncStatus, type AccessDevice } from '../api/client'
import { useT } from '../lib/i18n'
export function RecoverySettings() {
  const t = useT()
  const [sync, setSync] = useState<SyncStatus[]>([])
  const [devices, setDevices] = useState<AccessDevice[]>([])
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [admin, setAdmin] = useState(true)
  const refresh = async () => {
    try { setSync(await recoveryApi.syncStatus()) } catch (e) { setError(String(e)) }
    try { setDevices(await recoveryApi.devices()); setAdmin(true) } catch { setAdmin(false) }
  }
  useEffect(() => { refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer) }, [])
  return <section className="space-y-4 text-sm border-t border-line pt-4">
    <h3>{t('Synchronization and recovery')}</h3>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {sync.map(account => <div key={account.accountId} className="rounded-xl border border-line p-3">
      <strong>{account.email}</strong>
      <p>{account.syncing ? t('Syncing') : account.error ? t('Needs attention') : t('Ready')} - {account.scanned || 0} {t('messages checked')}</p>
      <p>{t('Last successful sync')}: {account.lastSuccessAt ? new Date(account.lastSuccessAt).toLocaleString() : t('Not yet synced')}</p>
      <p>{account.indexedMessages} {t('indexed messages')}. {t('Search covers inbox summaries and message bodies opened in Hermes.')}</p>
      {account.error && <p className="text-danger">{account.error}</p>}
      <button disabled={account.syncing} className="text-info" onClick={async () => { try { await recoveryApi.sync(account.accountId); await refresh() } catch (e) { setError(String(e)) } }}>{t('Retry sync')}</button>
    </div>)}
    <h3>{t('Device access')}</h3>
    {!admin ? <p>{t('Use the master token to manage devices.')}</p> : <>
      <p>{t('Create a separate token for each phone. Copy it into the connection settings on that device. It grants mailbox access but cannot manage other device tokens.')}</p>
      <form className="flex gap-2" onSubmit={async e => { e.preventDefault(); try { const device = await recoveryApi.addDevice(name); setToken(device.token); setName(''); setError(''); await refresh() } catch (e) { setError(String(e)) } }}>
        <input aria-label="Device name" required value={name} onChange={e => setName(e.target.value)} placeholder={t('Device name')} className="field flex-1" />
        <button className="text-info">{t('Create token')}</button>
      </form>
      {token && <div><p>{t('Copy this token now. It is shown only once.')}</p><textarea aria-label="New device token" readOnly value={token} className="field w-full" /><button onClick={() => setToken('')}>{t('Done')}</button></div>}
      {devices.map(device => <div key={device.id} className="flex gap-3"><span>{device.name} - {device.revokedAt ? t('Revoked') : t('Active')}</span>{!device.revokedAt && <button className="text-danger" onClick={async () => { try { await recoveryApi.revokeDevice(device.id); await refresh() } catch (e) { setError(String(e)) } }}>{t('Revoke')}</button>}</div>)}
    </>}
  </section>
}
