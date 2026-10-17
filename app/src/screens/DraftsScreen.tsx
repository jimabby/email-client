import { api } from '../api';
import { saveLocalDraft } from '../drafts';
import { useAppStore } from '../store';
import * as Crypto from 'expo-crypto';
import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { Alert, FlatList, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { localDrafts, removeLocalDraft, type MobileDraft } from '../drafts';
import { useTheme } from '../ThemeContext';
import { useTr } from '../i18n';
export default function DraftsScreen({ navigation }: NativeStackScreenProps<RootStackParamList, 'Drafts'>) {
  const [drafts, setDrafts] = useState<MobileDraft[]>([]); const { t } = useTheme(); const tr = useTr();
  const load = () => localDrafts().then(setDrafts).catch(e => Alert.alert(tr('Could not open drafts'), String(e)));
  const loadShared = async () => {
    try {
      const [shared, accounts, local] = await Promise.all([api.sharedDrafts(), api.listAccounts(), localDrafts()]);
      for (const item of shared) {
        const existing = local.find(d => d.id === item.id);
        if (existing?.serverRef?.revision === item.serverRef?.revision) continue;
        if (existing) await saveLocalDraft({ ...existing, id: Crypto.randomUUID(), requestId: Crypto.randomUUID(), serverRef: undefined });
        const account = accounts.find(a => a.id === item.accountId); if (!account) continue;
        await saveLocalDraft({ id: item.id, serverRef: item.serverRef, serverUrl: useAppStore.getState().serverUrl, account,
          inReplyTo: item.inReplyTo, references: item.references, replyToEmailId: item.replyToEmailId, replyToFolder: item.replyToFolder,
          to: item.to || '', cc: item.cc || '', bcc: item.bcc || '', subject: item.subject || '', body: item.text || '', attachments: item.attachments || [], savedAt: item.savedAt, requestId: Crypto.randomUUID() });
      }
      await load();
    } catch (e) { Alert.alert(tr('Could not load shared drafts'), String(e)); }
  };
  useFocusEffect(useCallback(() => { load(); }, []));
  return <FlatList style={{ backgroundColor: t.bg }} data={drafts} keyExtractor={d => d.id}
    ListHeaderComponent={<TouchableOpacity onPress={loadShared}><Text style={{ color: t.accent, padding: 20 }}>{tr('Load shared drafts (keep local edits)')}</Text></TouchableOpacity>}
    ListEmptyComponent={<Text style={{ color: t.text, padding: 20 }}>{tr('No local drafts')}</Text>}
    renderItem={({ item }) => <View style={{ padding: 20 }}>
      <TouchableOpacity onPress={() => navigation.navigate('Compose', { account: item.account, replyTo: item.replyTo, draft: item, prefill: item })}>
        <Text style={{ color: t.text }}>{item.subject || tr('(no subject)')}</Text><Text style={{ color: t.textMuted }}>{item.to} - {new Date(item.savedAt).toLocaleString()}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => Alert.alert(tr('Discard draft?'), item.subject, [{ text: tr('Cancel') }, { text: tr('Discard'), style: 'destructive', onPress: () => { removeLocalDraft(item.id).then(load).catch(e => Alert.alert(tr('Error'), String(e))); } }])}><Text style={{ color: t.danger }}>{tr('Discard')}</Text></TouchableOpacity>
    </View>} />;
}
