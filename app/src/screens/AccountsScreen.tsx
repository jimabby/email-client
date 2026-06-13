import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage } from '../api';
import { useAppStore } from '../store';
import { theme } from '../theme';
import { initials } from '../utils';
import type { Account } from '../types';
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

  const load = useCallback(async () => {
    setError(null);
    try {
      setAccounts(await api.listAccounts());
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
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: theme.bg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    gap: 12,
  },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  name: { color: theme.text, fontWeight: '600', fontSize: 15 },
  email: { color: theme.textMuted, fontSize: 13, marginTop: 2 },
  chevron: { color: theme.textFaint, fontSize: 26, fontWeight: '300' },
  errorTitle: { color: theme.text, fontSize: 16, fontWeight: '600', marginBottom: 8, textAlign: 'center' },
  errorMsg: { color: theme.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 16 },
  btn: { backgroundColor: theme.accent, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 11 },
  btnText: { color: theme.accentText, fontWeight: '700' },
});
