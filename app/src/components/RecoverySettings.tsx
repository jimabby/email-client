import { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { api, errorMessage, type SyncStatus, type AccessDevice } from '../api';
import { useTheme } from '../ThemeContext';
import { useTr } from '../i18n';
export function RecoverySettings() {
  const { t } = useTheme(); const tr = useTr();
  const [sync, setSync] = useState<SyncStatus[]>([]); const [devices, setDevices] = useState<AccessDevice[]>([]);
  const [admin, setAdmin] = useState(false); const [name, setName] = useState(''); const [token, setToken] = useState(''); const [error, setError] = useState('');
  const refresh = async () => {
    try { setSync(await api.syncStatus()); } catch (e) { setError(errorMessage(e)); }
    try { setDevices(await api.devices()); setAdmin(true); } catch { setAdmin(false); }
  };
  useEffect(() => { refresh(); const timer = setInterval(refresh, 8000); return () => clearInterval(timer); }, []);
  return <View style={{ gap: 12, marginTop: 20 }}>
    <Text style={{ color: t.text, fontWeight: 'bold' }}>{tr('Synchronization and recovery')}</Text>
    {error && <Text style={{ color: t.danger }}>{error}</Text>}
    {sync.map(account => <View key={account.accountId} style={{ gap: 6 }}>
      <Text style={{ color: t.text }}>{account.email} - {account.syncing ? tr('Syncing') : tr('Ready')}</Text>
      <Text style={{ color: t.textMuted }}>{tr('Last successful sync')}: {account.lastSuccessAt ? new Date(account.lastSuccessAt).toLocaleString() : tr('Not yet synced')}</Text>
      <Text style={{ color: t.textMuted }}>{account.scanned || 0} {tr('messages checked')} - {account.indexedMessages} {tr('indexed messages')}</Text>
      <Text style={{ color: t.textMuted }}>{tr('Search covers inbox summaries and message bodies opened in Hermes.')}</Text>
      {!!account.error && <Text style={{ color: t.danger }}>{account.error}</Text>}
      <TouchableOpacity disabled={account.syncing} onPress={() => api.sync(account.accountId).then(refresh).catch(e => setError(errorMessage(e)))}><Text style={{ color: t.accent }}>{tr('Retry sync')}</Text></TouchableOpacity>
    </View>)}
    <Text style={{ color: t.text, fontWeight: 'bold' }}>{tr('Device access')}</Text>
    {!admin ? <Text style={{ color: t.textMuted }}>{tr('Use the master token to manage devices.')}</Text> : <>
      <TextInput accessibilityLabel="Device name" value={name} onChangeText={setName} placeholder={tr('Device name')} style={{ color: t.text }} />
      <TouchableOpacity onPress={async () => { try { const device = await api.addDevice(name); setToken(device.token); setName(''); await refresh(); } catch (e) { setError(errorMessage(e)); } }}><Text style={{ color: t.accent }}>{tr('Create token')}</Text></TouchableOpacity>
      {!!token && <View><Text selectable style={{ color: t.text }}>{token}</Text><Text style={{ color: t.textMuted }}>{tr('Copy this token now. It is shown only once.')}</Text><TouchableOpacity onPress={() => setToken('')}><Text style={{ color: t.accent }}>{tr('Done')}</Text></TouchableOpacity></View>}
      {devices.map(device => <View key={device.id}><Text style={{ color: t.text }}>{device.name} - {device.revokedAt ? tr('Revoked') : tr('Active')}</Text>{!device.revokedAt && <TouchableOpacity onPress={() => api.revokeDevice(device.id).then(refresh).catch(e => setError(errorMessage(e)))}><Text style={{ color: t.danger }}>{tr('Revoke')}</Text></TouchableOpacity>}</View>)}
    </>}
  </View>;
}
