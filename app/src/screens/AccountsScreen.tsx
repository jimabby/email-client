import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage } from '../api';
import { useAppStore } from '../store';
import { theme, radius, space } from '../theme';
import { ui } from '../ui';
import { initials } from '../utils';
import type { Account, UnreadCounts } from '../types';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Accounts'>;

const TYPE_COLOR: Record<string, string> = {
  gmail: '#ea4335',
  outlook: '#0078d4',
  imap: theme.accent,
};

export default function AccountsScreen({ navigation }: Props) {
  const { serverUrl } = useAppStore();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [unread, setUnread] = useState<UnreadCounts>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      setAccounts(await api.listAccounts());
      // Real inbox totals from the provider, not a count of a fetched page.
      api.unreadCounts(['INBOX']).then(setUnread).catch(() => {});
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!serverUrl) {
      navigation.replace('Settings');
      return;
    }
    load();
  }, [serverUrl, load, navigation]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.accent} size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Can't reach the backend</Text>
        <Text style={styles.errorMsg}>{error}</Text>
        <TouchableOpacity style={styles.btn} onPress={() => navigation.navigate('Settings')}>
          <Text style={styles.btnText}>Open settings</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={accounts}
      keyExtractor={(a) => a.id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); load(); }}
          tintColor={theme.accent}
        />
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.errorTitle}>No accounts yet</Text>
          <Text style={styles.errorMsg}>
            Add an email account in the desktop app — it'll show up here.
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <TouchableOpacity
          style={styles.row}
          onPress={() => navigation.navigate('Inbox', { account: item })}
        >
          <View style={[styles.avatar, { backgroundColor: TYPE_COLOR[item.type] || theme.accent }]}>
            <Text style={styles.avatarText}>{initials(item.name || item.email)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={1}>{item.name || item.email}</Text>
            <Text style={styles.email} numberOfLines={1}>{item.email}</Text>
          </View>
          {(unread[item.id]?.INBOX?.unread ?? 0) > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {unread[item.id].INBOX.unread > 99 ? '99+' : unread[item.id].INBOX.unread}
              </Text>
            </View>
          )}
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: ui.screen,
  center: ui.center,
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    gap: space.md,
  },
  avatar: { width: 42, height: 42, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  name: { ...ui.bodyStrong },
  email: { ...ui.secondary, marginTop: 2 },
  badge: ui.badge,
  badgeText: ui.badgeText,
  chevron: { color: theme.textFaint, fontSize: 24, fontWeight: '300' },
  errorTitle: { ...ui.heading, marginBottom: space.sm, textAlign: 'center' },
  errorMsg: { ...ui.secondary, textAlign: 'center', lineHeight: 20, marginBottom: space.lg },
  btn: ui.btnPrimary,
  btnText: ui.btnPrimaryText,
});
