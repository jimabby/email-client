import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
  RefreshControl, TextInput,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage } from '../api';
import { theme, avatarColor, radius, space } from '../theme';
import { ui } from '../ui';
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
        <Text style={styles.searchIcon}>⌕</Text>
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
              <View style={styles.emptyIcon}>
                <Text style={styles.emptyGlyph}>{searchResults ? '⌕' : '✉'}</Text>
              </View>
              <Text style={styles.emptyTitle}>
                {searchResults ? 'No results' : 'Inbox zero'}
              </Text>
              <Text style={styles.emptyBody}>
                {searchResults
                  ? 'Try a different term, or pull down to refresh.'
                  : 'New mail will appear here as it arrives.'}
              </Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator color={theme.accent} style={{ marginVertical: 16 }} /> : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              activeOpacity={0.6}
              onPress={() => openEmail(item)}
              accessibilityRole="button"
              accessibilityLabel={`${item.read ? '' : 'Unread. '}${senderName(item.from)}. ${item.subject || 'No subject'}`}
            >
              {/* Unread reads as a bar on the leading edge, matching the
                  desktop list — a trailing dot competed with the timestamp. */}
              <View style={[styles.unreadBar, item.read && styles.unreadBarHidden]} />
              <View style={[styles.avatar, { backgroundColor: avatarColor(item.from) }]}>
                <Text style={styles.avatarText}>{initials(item.from)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.rowTop}>
                  <Text style={[styles.sender, !item.read && styles.senderUnread]} numberOfLines={1}>
                    {senderName(item.from)}
                  </Text>
                  <Text style={[styles.date, !item.read && styles.dateUnread]}>{formatDate(item.date)}</Text>
                </View>
                <Text style={[styles.subject, !item.read && styles.subjectUnread]} numberOfLines={1}>
                  {item.subject || '(no subject)'}
                </Text>
                {!!item.snippet && (
                  <Text style={styles.snippet} numberOfLines={1}>{item.snippet}</Text>
                )}
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: ui.screen,
  center: { ...ui.center, marginTop: 40 },
  composeBtn: ui.headerAction,
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.bgInput,
    marginHorizontal: space.md,
    marginTop: space.md,
    marginBottom: space.sm,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
  searchIcon: { color: theme.textFaint, fontSize: 18, marginTop: -2 },
  searchInput: { flex: 1, color: theme.text, paddingVertical: 10, fontSize: 15 },
  clear: { color: theme.textMuted, fontSize: 15, paddingHorizontal: 6 },

  row: {
    flexDirection: 'row',
    paddingRight: space.lg,
    paddingLeft: space.sm,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    gap: space.md,
    alignItems: 'center',
  },
  unreadBar: { width: 3, height: 22, borderRadius: 2, backgroundColor: theme.unread },
  unreadBarHidden: { backgroundColor: 'transparent' },

  avatar: { width: 40, height: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '600', fontSize: 14 },

  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: space.sm },
  sender: { color: theme.textMuted, fontSize: 15, fontWeight: '400', flex: 1 },
  senderUnread: { color: theme.text, fontWeight: '600' },
  subject: { color: theme.textMuted, fontSize: 13.5, marginTop: 1 },
  subjectUnread: { color: theme.text, fontWeight: '500' },
  snippet: { color: theme.textFaint, fontSize: 12.5, marginTop: 2 },
  date: { color: theme.textFaint, fontSize: 12 },
  dateUnread: { color: theme.accent, fontWeight: '600' },

  emptyIcon: {
    width: 60, height: 60, borderRadius: radius.xl,
    backgroundColor: theme.bgInput,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: space.lg,
  },
  emptyGlyph: { fontSize: 26, color: theme.textFaint },
  emptyTitle: { ...ui.heading, marginBottom: 6 },
  emptyBody: { ...ui.secondary, textAlign: 'center', lineHeight: 20, maxWidth: 260 },

  errorMsg: { color: theme.textMuted, fontSize: 14, textAlign: 'center', marginBottom: 14 },
  retry: ui.btnPrimary,
  retryText: ui.btnPrimaryText,
});
