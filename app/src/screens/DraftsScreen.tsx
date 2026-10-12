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
  useFocusEffect(useCallback(() => { load(); }, []));
  return <FlatList style={{ backgroundColor: t.bg }} data={drafts} keyExtractor={d => d.id}
    ListEmptyComponent={<Text style={{ color: t.text, padding: 20 }}>{tr('No local drafts')}</Text>}
    renderItem={({ item }) => <View style={{ padding: 20 }}>
      <TouchableOpacity onPress={() => navigation.navigate('Compose', { account: item.account, replyTo: item.replyTo, draft: item, prefill: item })}>
        <Text style={{ color: t.text }}>{item.subject || tr('(no subject)')}</Text><Text style={{ color: t.textMuted }}>{item.to} - {new Date(item.savedAt).toLocaleString()}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => Alert.alert(tr('Discard draft?'), item.subject, [{ text: tr('Cancel') }, { text: tr('Discard'), style: 'destructive', onPress: () => { removeLocalDraft(item.id).then(load).catch(e => Alert.alert(tr('Error'), String(e))); } }])}><Text style={{ color: t.danger }}>{tr('Discard')}</Text></TouchableOpacity>
    </View>} />;
}
