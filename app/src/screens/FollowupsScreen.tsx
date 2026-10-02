import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, FlatList, RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage } from '../api';
import { useTheme } from '../ThemeContext';
import { radius, space, type Palette } from '../theme';
import type { Ui } from '../ui';
import { relativeTime } from '../utils';
import type { Account, Followup } from '../types';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Followups'>;

const ORDER: Record<Followup['status'], number> = { due: 0, waiting: 1, replied: 2 };

/** Sent messages waiting on a reply — the phone's view of the desktop list. */
export default function FollowupsScreen({ navigation }: Props) {
  const { t, ui } = useTheme();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);

  const [items, setItems] = useState<Followup[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, accountList] = await Promise.all([api.followups(), api.listAccounts()]);
      setItems([...list].sort((a, b) => ORDER[a.status] - ORDER[b.status]));
      setAccounts(accountList);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (run: () => Promise<unknown>) => {
    try { await run(); await load(); } catch (err) { setError(errorMessage(err)); }
  };

  const nudge = (item: Followup) => {
    const account = accounts.find(a => a.id === item.accountId);
    if (!account) return;
    const subject = /^re:/i.test(item.subject) ? item.subject : `Re: ${item.subject}`;
    navigation.navigate('Compose', { account, prefill: { to: item.to, subject } });
  };

  if (loading) return <View style={styles.center}><ActivityIndicator color={t.accent} size="large" /></View>;

  return (
    <FlatList
      style={styles.container}
      data={items}
      keyExtractor={(f) => f.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={t.accent} />}
      ListHeaderComponent={error ? <Text style={styles.error}>{error}</Text> : null}
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Nothing to follow up on</Text>
          <Text style={styles.help}>Choose a reminder when you send a message, and it shows up here if nobody replies.</Text>
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowTop}>
            <Text style={[styles.status, item.status === 'due' ? styles.statusDue : item.status === 'replied' ? styles.statusReplied : null]}>
              {item.status === 'due' ? 'No reply' : item.status === 'replied' ? 'Replied' : 'Waiting'}
            </Text>
            <Text style={styles.subject} numberOfLines={1}>{item.subject}</Text>
          </View>
          <Text style={styles.meta} numberOfLines={1}>To {item.to}</Text>
          <Text style={styles.meta}>
            Sent {relativeTime(item.sentAt)}
            {item.status === 'waiting' ? ` · reminds ${relativeTime(item.dueAt)}` : ''}
          </Text>
          <View style={styles.actions}>
            {item.status === 'due' && (
              <TouchableOpacity onPress={() => nudge(item)}><Text style={styles.action}>Follow up</Text></TouchableOpacity>
            )}
            {item.status !== 'replied' && (
              <TouchableOpacity onPress={() => act(() => api.remindAgain(item.id, 3))}><Text style={styles.action}>Remind in 3 days</Text></TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => act(() => api.dismissFollowup(item.id))}><Text style={styles.dismiss}>Dismiss</Text></TouchableOpacity>
          </View>
        </View>
      )}
    />
  );
}

function makeStyles(t: Palette, ui: Ui) {
  return StyleSheet.create({
    container: ui.screen,
    center: ui.center,
    emptyTitle: { ...ui.heading, marginBottom: space.sm, textAlign: 'center' },
    help: { ...ui.secondary, textAlign: 'center', lineHeight: 19 },
    error: { color: t.danger, padding: space.lg },
    row: {
      paddingHorizontal: space.lg, paddingVertical: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border,
    },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    status: {
      fontSize: 10, fontWeight: '700', textTransform: 'uppercase', overflow: 'hidden',
      color: t.info, backgroundColor: t.bgInput, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill,
    },
    statusDue: { color: t.danger, backgroundColor: t.dangerSoft },
    statusReplied: { color: t.success },
    subject: { ...ui.bodyStrong, flex: 1 },
    meta: { ...ui.caption, marginTop: 3 },
    actions: { flexDirection: 'row', gap: space.lg, marginTop: space.sm },
    action: { color: t.accent, fontWeight: '600', fontSize: 13 },
    dismiss: { color: t.textMuted, fontWeight: '600', fontSize: 13 },
  });
}
