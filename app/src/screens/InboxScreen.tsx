import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
  RefreshControl, TextInput,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage } from '../api';
import { theme, avatarColor } from '../theme';
import { initials, senderName, formatDate } from '../utils';
import type { EmailSummary } from '../types';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Inbox'>;

export default function InboxScreen({ navigation, route }: Props) {
  const { account } = route.params;
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<EmailSummary[] | null>(null);
  const [snoozedIds, setSnoozedIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ emails: list, nextToken: nt }, snoozed] = await Promise.all([
        api.listEmails(account.id, 'INBOX', 50),
        api.listSnoozed().catch(() => []),
      ]);
      setEmails(list);
      setNextToken(nt);
      setSnoozedIds(new Set(snoozed.filter((s) => s.accountId === account.id).map((s) => s.emailId)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [account.id]);

  useEffect(() => { load(); }, [load]);

  // Refresh when returning to the inbox (e.g. after snoozing/archiving).
  useEffect(() => navigation.addListener('focus', () => { load(); }), [navigation, load]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity onPress={() => navigation.navigate('Compose', { account })}>
          <Text style={styles.composeBtn}>Compose</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, account]);

  const loadMore = async () => {
    if (!nextToken || loadingMore || searchResults) return;
    setLoadingMore(true);
    try {
      const { emails: more, nextToken: nt } = await api.listEmails(account.id, 'INBOX', 50, nextToken);
      setEmails((prev) => [...prev, ...more]);
      setNextToken(nt);
    } catch {
      // keep current list on pagination failure
    } finally {
      setLoadingMore(false);
    }
  };

  const runSearch = async () => {
    const q = query.trim();
    if (!q) { setSearchResults(null); return; }
    setSearching(true);
    try {
      setSearchResults(await api.search(account.id, q, 'INBOX', 50));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  const openEmail = (email: EmailSummary) => {
    if (!email.read) {
      setEmails((prev) => prev.map((e) => (e.id === email.id ? { ...e, read: true } : e)));
    }
    navigation.navigate('Viewer', { account, email });
  };

  const data = (searchResults ?? emails).filter((e) => !snoozedIds.has(e.id));

  return (
    <View style={styles.container}>
      <View style={styles.searchBar}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={runSearch}
          placeholder="Search mail…"
          placeholderTextColor={theme.textFaint}
          autoCapitalize="none"
          returnKeyType="search"
          style={styles.searchInput}
        />
        {(query.length > 0 || searchResults) && (
          <TouchableOpacity onPress={() => { setQuery(''); setSearchResults(null); }}>
            <Text style={styles.clear}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading || searching ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} size="large" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorMsg}>{error}</Text>
          <TouchableOpacity style={styles.retry} onPress={load}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(e) => e.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); setSearchResults(null); setQuery(''); load(); }}
              tintColor={theme.accent}
            />
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.errorMsg}>
                {searchResults ? 'No results' : 'This inbox is empty'}
              </Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator color={theme.accent} style={{ marginVertical: 16 }} /> : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => openEmail(item)}>
              <View style={[styles.avatar, { backgroundColor: avatarColor(item.from) }]}>
                <Text style={styles.avatarText}>{initials(item.from)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.rowTop}>
                  <Text
                    style={[styles.sender, !item.read && styles.unreadText]}
                    numberOfLines={1}
                  >
                    {senderName(item.from)}
                  </Text>
                  <Text style={styles.date}>{formatDate(item.date)}</Text>
                </View>
                <Text style={[styles.subject, !item.read && styles.unreadText]} numberOfLines={1}>
                  {item.subject || '(no subject)'}
                </Text>
                {!!item.snippet && (
                  <Text style={styles.snippet} numberOfLines={1}>{item.snippet}</Text>
                )}
              </View>
              {!item.read && <View style={styles.dot} />}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32, marginTop: 60 },
  composeBtn: { color: theme.accent, fontWeight: '700', fontSize: 15 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.bgElevated,
    margin: 12,
    borderRadius: 10,
    paddingHorizontal: 12,
    borderColor: theme.border,
    borderWidth: 1,
  },
  searchInput: { flex: 1, color: theme.text, paddingVertical: 9, fontSize: 15 },
  clear: { color: theme.textMuted, fontSize: 15, paddingHorizontal: 6 },
  row: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    gap: 12,
    alignItems: 'center',
  },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  sender: { color: theme.textMuted, fontSize: 14, fontWeight: '500', flex: 1 },
  subject: { color: theme.textMuted, fontSize: 13, marginTop: 2 },
  snippet: { color: theme.textFaint, fontSize: 12, marginTop: 2 },
  unreadText: { color: theme.text, fontWeight: '700' },
  date: { color: theme.textFaint, fontSize: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.unread },
  errorMsg: { color: theme.textMuted, fontSize: 14, textAlign: 'center', marginBottom: 14 },
  retry: { backgroundColor: theme.accent, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { color: theme.accentText, fontWeight: '700' },
});
