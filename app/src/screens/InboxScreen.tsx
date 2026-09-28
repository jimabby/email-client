import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator,
  RefreshControl, TextInput, Animated,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage, resolveArchiveFolder } from '../api';
import { useTheme } from '../ThemeContext';
import { avatarColor, radius, space, type Palette } from '../theme';
import type { Ui } from '../ui';
import { initials, senderName, formatDate } from '../utils';
import { clearBadge } from '../push';
import type { EmailSummary } from '../types';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Inbox'>;

const PAGE = 50;

export default function InboxScreen({ navigation, route }: Props) {
  const { account, folder = 'INBOX', unified = false } = route.params;
  const { t, ui } = useTheme();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);

  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [unifiedTokens, setUnifiedTokens] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<EmailSummary[] | null>(null);
  const [snoozedIds, setSnoozedIds] = useState<Set<string>>(new Set());
  const [archiveFolder, setArchiveFolder] = useState('Archive');
  // Multi-select. A long press starts it; while it is on, a tap toggles a row
  // instead of opening it, and swipes are off so a stray gesture cannot act
  // on one message while the user is choosing several.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selecting = selected.size > 0;
  const [bulkBusy, setBulkBusy] = useState(false);
  // One pending undo, shown as a banner until it expires.
  const [undo, setUndo] = useState<{ label: string; run: () => Promise<void> } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const offerUndo = (label: string, run: () => Promise<void>) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ label, run });
    undoTimer.current = setTimeout(() => setUndo(null), 7000);
  };
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  // A returning screen must not silently throw away everything the user paged
  // in. `loaded` marks that we have a list; the focus listener below refreshes
  // only the first page's worth in place rather than resetting pagination.
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const snoozedPromise = api.listSnoozed().catch(() => []);

      if (unified) {
        const page = await api.unified(folder, PAGE);
        setEmails(page.emails);
        setUnifiedTokens(page.nextTokens);
        setNextToken(Object.values(page.nextTokens).some(Boolean) ? 'unified' : null);
        if (page.errors.length) setError(`${page.errors[0].email}: ${page.errors[0].error}`);
      } else {
        const { emails: list, nextToken: nt } = await api.listEmails(account.id, folder, PAGE);
        setEmails(list);
        setNextToken(nt);
      }

      const snoozed = await snoozedPromise;
      setSnoozedIds(new Set(
        snoozed.filter((s) => unified || s.accountId === account.id).map((s) => s.emailId),
      ));
      loadedRef.current = true;
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [account.id, folder, unified]);

  useEffect(() => { load(); }, [load]);

  // Reading mail on the phone is what clears the icon badge.
  useEffect(() => { clearBadge(); }, []);

  // Resolve the archive destination once so the swipe action is instant.
  useEffect(() => {
    if (unified) return;
    api.getFolders(account.id)
      .then((folders) => setArchiveFolder(resolveArchiveFolder(folders)))
      .catch(() => { /* the 'Archive' default is a reasonable guess */ });
  }, [account.id, unified]);

  /**
   * Refresh the top of the list when the screen comes back into view.
   *
   * This used to call load(), which reset pagination to the first page — so
   * paging through 200 messages, opening one, and coming back left the user
   * with 50 again. Merging the newest page keeps everything already scrolled
   * past in place.
   */
  useEffect(() => navigation.addListener('focus', () => {
    if (!loadedRef.current) return;
    const merge = (fresh: EmailSummary[]) => {
      setEmails((prev) => {
        const byId = new Map(prev.map((e) => [e.id, e]));
        for (const email of fresh) byId.set(email.id, email);
        return Array.from(byId.values())
          .sort((a, b) => Date.parse(b.date || '') - Date.parse(a.date || ''));
      });
    };
    const request = unified
      ? api.unified(folder, PAGE).then((p) => p.emails)
      : api.listEmails(account.id, folder, PAGE).then((p) => p.emails);
    request.then(merge).catch(() => { /* keep what is on screen */ });
    api.listSnoozed()
      .then((snoozed) => setSnoozedIds(new Set(
        snoozed.filter((s) => unified || s.accountId === account.id).map((s) => s.emailId),
      )))
      .catch(() => {});
  }), [navigation, account.id, folder, unified]);

  const data = (searchResults ?? emails).filter((e) => !snoozedIds.has(e.id));

  useLayoutEffect(() => {
    if (selecting) {
      navigation.setOptions({
        title: `${selected.size} selected`,
        headerRight: () => (
          <View style={styles.headerActions}>
            <TouchableOpacity onPress={() => setSelected(new Set(data.map((e) => e.id)))} hitSlop={8}>
              <Text style={styles.headerAction}>All</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setSelected(new Set())} hitSlop={8}>
              <Text style={styles.headerAction}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ),
      });
      return;
    }
    navigation.setOptions({
      title: unified ? 'All inboxes' : folder === 'INBOX' ? (account.name || account.email) : folder,
      headerRight: () => (
        <View style={styles.headerActions}>
          {!unified && (
            <TouchableOpacity onPress={() => navigation.navigate('Folders', { account })} hitSlop={8}>
              <Text style={styles.headerAction}>Folders</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => navigation.navigate('Compose', { account })} hitSlop={8}>
            <Text style={styles.headerAction}>Compose</Text>
          </TouchableOpacity>
        </View>
      ),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, account, folder, unified, styles, selecting, selected.size, data.length]);

  const loadMore = async () => {
    if (!nextToken || loadingMore || searchResults) return;
    setLoadingMore(true);
    try {
      if (unified) {
        const page = await api.unified(folder, PAGE, unifiedTokens);
        setEmails((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...page.emails.filter((e) => !seen.has(e.id))];
        });
        setUnifiedTokens(page.nextTokens);
        setNextToken(Object.values(page.nextTokens).some(Boolean) ? 'unified' : null);
      } else {
        const { emails: more, nextToken: nt } = await api.listEmails(account.id, folder, PAGE, nextToken);
        setEmails((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...more.filter((e) => !seen.has(e.id))];
        });
        setNextToken(nt);
      }
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
      // The local index answers across every account and without a provider
      // round-trip, which is what a unified search needs.
      setSearchResults(unified
        ? await api.searchIndex(q, { limit: PAGE })
        : await api.search(account.id, q, folder, PAGE));
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

  // Optimistic: the row leaves immediately and comes back if the call fails.
  const removeLocally = (id: string) => setEmails((prev) => prev.filter((e) => e.id !== id));

  const archiveEmail = async (email: EmailSummary) => {
    removeLocally(email.id);
    try {
      await api.move(email.accountId, email.id, archiveFolder, email.folder);
    } catch (err) {
      setError(errorMessage(err));
      load();
    }
  };

  const deleteEmail = async (email: EmailSummary) => {
    removeLocally(email.id);
    try {
      const { undoId } = await api.delete(email.accountId, email.id, email.folder);
      if (undoId) {
        offerUndo('Moved to Trash', async () => {
          await api.untrash(email.accountId, undoId, email.folder || 'INBOX');
          load();
        });
      }
    } catch (err) {
      setError(errorMessage(err));
      load();
    }
  };

  const toggleSelected = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /**
   * Run one action over the selection. The bulk endpoints take one account and
   * folder at a time, and a unified or search list mixes both, so the
   * selection is grouped first.
   */
  const runBulk = async (action: 'delete' | 'read' | 'unread' | 'archive') => {
    const chosen = (searchResults ?? emails).filter((e) => selected.has(e.id));
    if (!chosen.length) return;
    const groups = new Map<string, { accountId: string; folder: string; ids: string[] }>();
    for (const email of chosen) {
      const key = `${email.accountId}\u0000${email.folder}`;
      if (!groups.has(key)) groups.set(key, { accountId: email.accountId, folder: email.folder, ids: [] });
      groups.get(key)!.ids.push(email.id);
    }

    setBulkBusy(true);
    const ids = new Set(chosen.map((e) => e.id));
    if (action === 'delete' || action === 'archive') {
      setEmails((prev) => prev.filter((e) => !ids.has(e.id)));
      setSearchResults((prev) => prev && prev.filter((e) => !ids.has(e.id)));
    } else {
      const read = action === 'read';
      setEmails((prev) => prev.map((e) => (ids.has(e.id) ? { ...e, read } : e)));
      setSearchResults((prev) => prev && prev.map((e) => (ids.has(e.id) ? { ...e, read } : e)));
    }
    setSelected(new Set());

    try {
      let failed = 0;
      for (const group of groups.values()) {
        let result;
        if (action === 'archive') {
          // Each account keeps its own archive folder.
          const target = unified || group.accountId !== account.id
            ? resolveArchiveFolder(await api.getFolders(group.accountId).catch(() => []))
            : archiveFolder;
          result = await api.bulk('move', group.accountId, group.ids, group.folder, target);
        } else {
          result = await api.bulk(action, group.accountId, group.ids, group.folder);
        }
        failed += result.failed;
      }
      if (failed) setError(`${failed} message${failed === 1 ? '' : 's'} could not be updated`);
    } catch (err) {
      setError(errorMessage(err));
      load();
    } finally {
      setBulkBusy(false);
    }
  };


  /**
   * The action revealed behind a swiped row.
   *
   * Swiping is the primary gesture in every mobile mail client and this app had
   * none: archiving or deleting meant opening the message first, which is three
   * taps for something that should be one.
   */
  const renderAction = (
    email: EmailSummary,
    side: 'left' | 'right',
    progress: Animated.AnimatedInterpolation<number>,
  ) => {
    const isArchive = side === 'left';
    const translateX = progress.interpolate({
      inputRange: [0, 1],
      outputRange: isArchive ? [-88, 0] : [88, 0],
      extrapolate: 'clamp',
    });
    return (
      <Animated.View
        style={[
          styles.swipeAction,
          { backgroundColor: isArchive ? t.swipeArchive : t.swipeDelete, transform: [{ translateX }] },
        ]}
      >
        <Text style={styles.swipeGlyph}>{isArchive ? '🗄' : '🗑'}</Text>
        <Text style={styles.swipeLabel}>{isArchive ? 'Archive' : 'Delete'}</Text>
      </Animated.View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.searchBar}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={runSearch}
          placeholder={unified ? 'Search all mail…' : 'Search mail…'}
          placeholderTextColor={t.textFaint}
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
          <ActivityIndicator color={t.accent} size="large" />
        </View>
      ) : error && !data.length ? (
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
              tintColor={t.accent}
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
                {searchResults ? 'No results' : folder === 'INBOX' ? 'Inbox zero' : `Nothing in ${folder}`}
              </Text>
              <Text style={styles.emptyBody}>
                {searchResults
                  ? 'Try a different term, or pull down to refresh.'
                  : 'New mail will appear here as it arrives.'}
              </Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator color={t.accent} style={{ marginVertical: 16 }} /> : null
          }
          renderItem={({ item }) => (
            <Swipeable
              enabled={!selecting}
              renderLeftActions={(progress) => renderAction(item, 'left', progress)}
              renderRightActions={(progress) => renderAction(item, 'right', progress)}
              onSwipeableOpen={(direction) => {
                if (direction === 'left') archiveEmail(item);
                else deleteEmail(item);
              }}
              leftThreshold={72}
              rightThreshold={72}
              overshootLeft={false}
              overshootRight={false}
            >
              <TouchableOpacity
                style={[styles.row, selected.has(item.id) && styles.rowSelected]}
                activeOpacity={0.6}
                onPress={() => (selecting ? toggleSelected(item.id) : openEmail(item))}
                onLongPress={() => toggleSelected(item.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: selected.has(item.id) }}
                accessibilityLabel={`${item.read ? '' : 'Unread. '}${senderName(item.from)}. ${item.subject || 'No subject'}`}
                accessibilityHint={selecting
                  ? 'Tap to select or deselect.'
                  : 'Swipe right to archive, left to delete. Long press to select several.'}
              >
                {/* Unread reads as a bar on the leading edge, matching the
                    desktop list — a trailing dot competed with the timestamp. */}
                <View style={[styles.unreadBar, item.read && styles.unreadBarHidden]} />
                {selecting ? (
                  <View style={[styles.avatar, styles.check, selected.has(item.id) && styles.checkOn]}>
                    <Text style={styles.checkGlyph}>{selected.has(item.id) ? '✓' : ''}</Text>
                  </View>
                ) : (
                  <View style={[styles.avatar, { backgroundColor: avatarColor(item.from) }]}>
                    <Text style={styles.avatarText}>{initials(item.from)}</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <View style={styles.rowTop}>
                    <Text style={[styles.sender, !item.read && styles.senderUnread]} numberOfLines={1}>
                      {senderName(item.from)}
                    </Text>
                    {item.hasAttachments && (
                      <Text style={styles.clip} accessibilityLabel="Has attachments">📎</Text>
                    )}
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
            </Swipeable>
          )}
        />
      )}

      {selecting && (
        <View style={styles.bulkBar}>
          {([
            ['archive', 'Archive'],
            ['delete', 'Delete'],
            ['read', 'Read'],
            ['unread', 'Unread'],
          ] as const).map(([action, label]) => (
            <TouchableOpacity
              key={action}
              style={styles.bulkBtn}
              disabled={bulkBusy}
              onPress={() => runBulk(action)}
              accessibilityRole="button"
            >
              <Text style={[styles.bulkText, action === 'delete' && styles.bulkDanger]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {undo && !selecting && (
        <View style={styles.undoBar}>
          <Text style={styles.undoText}>{undo.label}</Text>
          <TouchableOpacity
            onPress={() => {
              const run = undo.run;
              setUndo(null);
              run().catch((err) => setError(errorMessage(err)));
            }}
            hitSlop={8}
          >
            <Text style={styles.undoAction}>Undo</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function makeStyles(t: Palette, ui: Ui) {
  return StyleSheet.create({
    container: ui.screen,
    center: { ...ui.center, marginTop: 40 },
    headerActions: { flexDirection: 'row', gap: space.lg, alignItems: 'center' },
    headerAction: ui.headerAction,
    searchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.bgInput,
      marginHorizontal: space.md,
      marginTop: space.md,
      marginBottom: space.sm,
      borderRadius: radius.md,
      paddingHorizontal: space.md,
      borderColor: t.border,
      borderWidth: StyleSheet.hairlineWidth,
      gap: space.sm,
    },
    searchIcon: { color: t.textFaint, fontSize: 18, marginTop: -2 },
    searchInput: { flex: 1, color: t.text, paddingVertical: 10, fontSize: 15 },
    clear: { color: t.textMuted, fontSize: 15, paddingHorizontal: 6 },

    row: {
      flexDirection: 'row',
      paddingRight: space.lg,
      paddingLeft: space.sm,
      paddingVertical: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
      gap: space.md,
      alignItems: 'center',
      // Opaque, so the swipe action behind it is hidden until it is revealed.
      backgroundColor: t.bg,
    },
    rowSelected: { backgroundColor: t.bgInput },
    check: { backgroundColor: 'transparent', borderWidth: 2, borderColor: t.border },
    checkOn: { backgroundColor: t.accent, borderColor: t.accent },
    checkGlyph: { color: '#fff', fontWeight: '700', fontSize: 18 },
    clip: { fontSize: 11, color: t.textFaint },
    bulkBar: {
      flexDirection: 'row',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
      backgroundColor: t.bg,
      paddingVertical: space.sm,
    },
    bulkBtn: { flex: 1, alignItems: 'center', paddingVertical: space.sm },
    bulkText: { color: t.accent, fontSize: 15, fontWeight: '600' },
    bulkDanger: { color: t.swipeDelete },
    undoBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginHorizontal: space.md,
      marginBottom: space.md,
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
      borderRadius: radius.md,
      backgroundColor: t.text,
    },
    undoText: { color: t.bg, fontSize: 14 },
    undoAction: { color: t.accent, fontSize: 14, fontWeight: '700' },
    unreadBar: { width: 3, height: 22, borderRadius: 2, backgroundColor: t.unread },
    unreadBarHidden: { backgroundColor: 'transparent' },

    swipeAction: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: space.xl,
      gap: 2,
    },
    swipeGlyph: { fontSize: 20 },
    swipeLabel: { color: '#fff', fontSize: 12, fontWeight: '700' },

    avatar: { width: 40, height: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
    avatarText: { color: '#fff', fontWeight: '600', fontSize: 14 },

    rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: space.sm },
    sender: { color: t.textMuted, fontSize: 15, fontWeight: '400', flex: 1 },
    senderUnread: { color: t.text, fontWeight: '600' },
    subject: { color: t.textMuted, fontSize: 13.5, marginTop: 1 },
    subjectUnread: { color: t.text, fontWeight: '500' },
    snippet: { color: t.textFaint, fontSize: 12.5, marginTop: 2 },
    date: { color: t.textFaint, fontSize: 12 },
    dateUnread: { color: t.accent, fontWeight: '600' },

    emptyIcon: {
      width: 60, height: 60, borderRadius: radius.xl,
      backgroundColor: t.bgInput,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: space.lg,
    },
    emptyGlyph: { fontSize: 26, color: t.textFaint },
    emptyTitle: { ...ui.heading, marginBottom: 6 },
    emptyBody: { ...ui.secondary, textAlign: 'center', lineHeight: 20, maxWidth: 260 },

    errorMsg: { color: t.textMuted, fontSize: 14, textAlign: 'center', marginBottom: 14 },
    retry: ui.btnPrimary,
    retryText: ui.btnPrimaryText,
  });
}
