import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage } from '../api';
import { useTheme } from '../ThemeContext';
import { radius, space, type Palette } from '../theme';
import type { Ui } from '../ui';
import type { Folder, UnreadCounts } from '../types';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Folders'>;

/**
 * The account's mailboxes.
 *
 * The phone could only ever show INBOX: `getFolders` existed in the API client
 * but was used solely to guess an archive destination, so Sent, Drafts,
 * Archive, Trash and every user-made folder were unreachable from mobile. The
 * desktop sidebar has always listed them.
 */

const GLYPHS: Array<[RegExp, string]> = [
  [/^inbox$/i, '📥'],
  [/^sent/i, '📤'],
  [/^draft/i, '📝'],
  [/^trash$|^deleted/i, '🗑'],
  [/^spam$|^junk/i, '⚠️'],
  [/^archive$|all ?mail/i, '🗄'],
  [/^starred|^flagged/i, '⭐'],
];

function glyphFor(folder: Folder): string {
  for (const [pattern, glyph] of GLYPHS) {
    if (pattern.test(folder.name) || pattern.test(folder.path)) return glyph;
  }
  return '📁';
}

export default function FoldersScreen({ navigation, route }: Props) {
  const { account } = route.params;
  const { t, ui } = useTheme();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);

  const [folders, setFolders] = useState<Folder[]>([]);
  const [counts, setCounts] = useState<UnreadCounts>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.getFolders(account.id);
      setFolders(list);
      // Provider-reported totals, not a count of whatever page is loaded. The
      // endpoint caps the folder set, so ask only for what is on screen.
      api.unreadCounts(list.slice(0, 12).map((f) => f.path))
        .then(setCounts)
        .catch(() => { /* badges are decoration */ });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [account.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => navigation.addListener('focus', load), [navigation, load]);

  const unreadFor = (path: string) => counts[account.id]?.[path]?.unread || 0;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={t.accent} size="large" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorMsg}>{error}</Text>
        <TouchableOpacity style={styles.retry} onPress={load}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: space.lg }}
      data={folders}
      keyExtractor={(f) => f.path}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); load(); }}
          tintColor={t.accent}
        />
      }
      ListHeaderComponent={
        <Text style={styles.accountLabel} numberOfLines={1}>{account.email}</Text>
      }
      ItemSeparatorComponent={() => <View style={styles.hairline} />}
      renderItem={({ item, index }) => {
        const unread = unreadFor(item.path);
        return (
          <TouchableOpacity
            style={[
              styles.row,
              index === 0 && styles.rowFirst,
              index === folders.length - 1 && styles.rowLast,
            ]}
            activeOpacity={0.7}
            onPress={() => navigation.navigate('Inbox', { account, folder: item.path })}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}${unread ? `, ${unread} unread` : ''}`}
          >
            <Text style={styles.glyph}>{glyphFor(item)}</Text>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            {unread > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
              </View>
            )}
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        );
      }}
    />
  );
}

function makeStyles(t: Palette, ui: Ui) {
  return StyleSheet.create({
    container: ui.screen,
    center: ui.center,
    accountLabel: { ...ui.overline, marginBottom: space.md },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      backgroundColor: t.bgElevated,
      paddingHorizontal: space.lg,
      paddingVertical: 14,
    },
    rowFirst: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
    rowLast: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
    hairline: { height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginLeft: space.xl + space.lg },

    glyph: { fontSize: 17, width: 24, textAlign: 'center' },
    name: { ...ui.body, flex: 1 },
    badge: ui.badge,
    badgeText: ui.badgeText,
    chevron: { color: t.textFaint, fontSize: 22, marginTop: -2 },

    errorMsg: { color: t.textMuted, fontSize: 14, textAlign: 'center', marginBottom: 14 },
    retry: ui.btnPrimary,
    retryText: ui.btnPrimaryText,
  });
}
