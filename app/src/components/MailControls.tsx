import { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Switch } from 'react-native';
import { api, errorMessage } from '../api';
import { useTheme } from '../ThemeContext';
import type { Account, Folder } from '../types';
export function MailControls() {
  const { t } = useTheme();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState('INBOX');
  const [since, setSince] = useState(''); const [until, setUntil] = useState('');
  const [coverage, setCoverage] = useState<any>(null);
  const [privacy, setPrivacy] = useState<{ localOnly: boolean; automaticAccounts: string[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.listAccounts().then(list => { setAccounts(list); setAccountId(list[0]?.id || ''); }).catch(e => setError(errorMessage(e)));
    api.aiPrivacy().then(setPrivacy).catch(e => setError(errorMessage(e)));
    const refresh = () => api.coverage().then(setCoverage).catch(e => setError(errorMessage(e)));
    refresh(); const timer = setInterval(refresh, 8000); return () => clearInterval(timer);
  }, []);
  useEffect(() => { if (accountId) api.getFolders(accountId).then(setFolders).catch(e => setError(errorMessage(e))); }, [accountId]);
  const savePrivacy = async (value: NonNullable<typeof privacy>) => { try { await api.saveAiPrivacy(value); setPrivacy(value); } catch (e) { setError(errorMessage(e)); } };
  return <View style={{ gap: 12, marginTop: 20 }}>
    <Text style={{ color: t.text, fontWeight: 'bold' }}>AI privacy</Text>
    <Text style={{ color: t.text }}>Local-only mode blocks external AI calls. Draft assistance previews the text before sending. Automatic completion is a desktop feature that sends drafts after a typing pause.</Text>
    {privacy && <><Text style={{ color: t.text }}>Local-only mode</Text><Switch accessibilityLabel="Local-only mode" value={privacy.localOnly} onValueChange={localOnly => savePrivacy({ ...privacy, localOnly })} />
      {accounts.map(a => <View key={a.id}><Text style={{ color: t.text }}>Automatic completion: {a.email}</Text><Switch disabled={privacy.localOnly} value={privacy.automaticAccounts.includes(a.id)} onValueChange={enabled => savePrivacy({ ...privacy, automaticAccounts: enabled ? [...privacy.automaticAccounts, a.id] : privacy.automaticAccounts.filter(id => id !== a.id) })} /></View>)}</>}
    <Text style={{ color: t.text, fontWeight: 'bold' }}>Search coverage</Text>
    <Text style={{ color: t.text }}>Coverage is limited to retained messages. Backfill downloads bodies for the selected dates. Index limit: {coverage?.limit || 50000}.</Text>
    {coverage?.folders?.map((f: any) => <Text key={f.accountId + f.folder} style={{ color: t.textMuted }}>{accounts.find(a => a.id === f.accountId)?.email} / {f.folder}: {f.messages} summaries, {f.bodies} bodies; {f.oldest?.slice(0, 10)} — {f.newest?.slice(0, 10)}</Text>)}
    {accounts.map(a => <TouchableOpacity key={a.id} onPress={() => { setAccountId(a.id); setFolder('INBOX'); }}><Text style={{ color: accountId === a.id ? t.accent : t.text }}>{accountId === a.id ? '✓ ' : ''}{a.email}</Text></TouchableOpacity>)}
    {folders.map(f => <TouchableOpacity key={f.path} onPress={() => setFolder(f.path)}><Text style={{ color: folder === f.path ? t.accent : t.text }}>{folder === f.path ? '✓ ' : ''}{f.name}</Text></TouchableOpacity>)}
    <TextInput accessibilityLabel="Backfill from" placeholder="From YYYY-MM-DD (optional)" value={since} onChangeText={setSince} style={{ color: t.text }} />
    <TextInput accessibilityLabel="Backfill through" placeholder="Through YYYY-MM-DD (optional)" value={until} onChangeText={setUntil} style={{ color: t.text }} />
    <TouchableOpacity disabled={!accountId || coverage?.jobs?.some((j: any) => j.accountId === accountId && j.running)} onPress={async () => { try { await api.backfill({ accountId, folder, since, until }); setCoverage(await api.coverage()); setError(''); } catch (e) { setError(errorMessage(e)); } }}><Text style={{ color: t.accent }}>Backfill selected range</Text></TouchableOpacity>
    {coverage?.jobs?.map((j: any) => <Text key={j.accountId} style={{ color: t.text }}>{j.folder}: {j.running ? 'Running' : 'Stopped'} — {j.indexed} indexed / {j.scanned} checked. {j.error}</Text>)}
    {!!error && <Text style={{ color: t.danger }}>{error}</Text>}
  </View>;
}
