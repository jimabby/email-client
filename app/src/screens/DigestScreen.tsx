import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, FlatList, RefreshControl, Switch, Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage } from '../api';
import { useTheme } from '../ThemeContext';
import { radius, space, type Palette } from '../theme';
import type { Ui } from '../ui';
import { relativeTime, initials } from '../utils';
import { useTr } from '../i18n';
import type { DigestGroup, DigestState } from '../types';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Digest'>;

/**
 * The phone's view of the newsletter digest: what collected today, grouped by
 * sender. Tapping a subject opens it from the digest folder; "Not a
 * newsletter" sends that sender back to the inbox for good.
 */
export default function DigestScreen({ navigation }: Props) {
  const { t, ui } = useTheme();
  const tr = useTr();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);

  const [state, setState] = useState<DigestState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.digest());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    try { await work(); await load(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(null); }
  };

  const release = (group: DigestGroup) => {
    Alert.alert(
      tr('Not a newsletter'),
      tr('Not a newsletter: keep this sender in the inbox and move their mail back'),
      [
        { text: tr('Cancel'), style: 'cancel' },
        { text: tr('Keep in inbox'), onPress: () => run(group.sender, () => api.releaseDigestSender(group.sender)) },
      ],
    );
  };

  const open = async (group: DigestGroup, index: number) => {
    const email = group.emails[index];
    try {
      const accounts = await api.listAccounts();
      const account = accounts.find(a => a.id === email.accountId);
      if (account) navigation.navigate('Viewer', { account, email: { ...email, folder: email.digestFolder } });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (loading) return <View style={styles.center}><ActivityIndicator color={t.accent} size="large" /></View>;

  const settings = state?.settings;
  const unread = state?.groups.reduce((sum, g) => sum + g.unread, 0) || 0;

  const header = (
    <View>
      <View style={styles.toggleRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.toggleTitle}>{tr('Digest')}</Text>
          <Text style={styles.help}>
            {settings?.enabled
              ? tr('Newsletters wait here instead of your inbox. You get one notification a day, at {time}.', { time: settings.deliverAt })
              : tr('Collect newsletters in one place and hear about them once a day, not one at a time.')}
          </Text>
        </View>
        <Switch
          value={!!settings?.enabled}
          onValueChange={(enabled) => run('toggle', () => api.configureDigest({ enabled }))}
          disabled={busy === 'toggle' || !settings}
          trackColor={{ true: t.accent, false: t.bgInput }}
          accessibilityLabel={settings?.enabled ? tr('Turn the digest off') : tr('Turn the digest on')}
        />
      </View>
      {unread > 0 && (
        <TouchableOpacity style={styles.readAll} onPress={() => run('read-all', () => api.readAllDigest())} disabled={busy === 'read-all'}>
          <Text style={styles.readAllText}>{tr('Mark all read')}</Text>
        </TouchableOpacity>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      {state?.errors.map(e => <Text key={e.accountId} style={styles.error}>{e.email}: {e.error}</Text>)}
    </View>
  );

  return (
    <FlatList
      style={styles.container}
      data={state?.groups || []}
      keyExtractor={(g) => g.sender}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={t.accent} />}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>{settings?.enabled ? tr('Nothing waiting. Newsletters will collect here.') : tr('The digest is off')}</Text>
          {!settings?.enabled && (
            <Text style={styles.help}>
              {tr('Turn it on and newsletters arriving from now on are filed into a “{folder}” folder. Nothing already in your inbox is moved.', { folder: settings?.folder || 'Digest' })}
            </Text>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowTop}>
            <View style={[styles.avatar, { backgroundColor: t.accent }]}>
              <Text style={styles.avatarText}>{initials(item.name || item.sender)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>{item.name || item.sender}</Text>
              <Text style={styles.meta}>{relativeTime(item.latest)}{item.unread ? ` · ${item.unread} ${tr('New')}` : ''}</Text>
            </View>
            {busy === item.sender ? <ActivityIndicator color={t.accent} /> : (
              <TouchableOpacity onPress={() => release(item)} hitSlop={8}>
                <Text style={styles.release}>{tr('Not a newsletter')}</Text>
              </TouchableOpacity>
            )}
          </View>
          {item.emails.slice(0, 4).map((email, index) => (
            <TouchableOpacity key={email.id} onPress={() => open(item, index)} style={styles.subjectRow} accessibilityRole="button">
              <Text style={[styles.subject, email.read && styles.subjectRead]} numberOfLines={1}>{email.subject || tr('(no subject)')}</Text>
            </TouchableOpacity>
          ))}
          {item.count > 4 && <Text style={styles.meta}>{tr('and {count} more', { count: item.count - 4 })}</Text>}
        </View>
      )}
    />
  );
}

function makeStyles(t: Palette, ui: Ui) {
  return StyleSheet.create({
    container: ui.screen,
    center: ui.center,
    toggleRow: {
      flexDirection: 'row', alignItems: 'center', gap: space.md,
      padding: space.lg, backgroundColor: t.bgAlt,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border,
    },
    toggleTitle: { ...ui.bodyStrong, marginBottom: 4 },
    emptyTitle: { ...ui.heading, marginBottom: space.sm, textAlign: 'center' },
    help: { ...ui.secondary, lineHeight: 19 },
    error: { color: t.danger, paddingHorizontal: space.lg, paddingTop: space.md },
    readAll: { paddingHorizontal: space.lg, paddingVertical: space.md, alignSelf: 'flex-end' },
    readAllText: { color: t.accent, fontWeight: '600' },
    row: {
      paddingHorizontal: space.lg, paddingVertical: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border,
    },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.sm },
    avatar: { width: 36, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
    avatarText: { color: t.accentText, fontWeight: '700', fontSize: 13 },
    name: { ...ui.bodyStrong },
    subjectRow: { paddingVertical: 6 },
    subject: { ...ui.body },
    subjectRead: { color: t.textMuted },
    meta: { ...ui.caption, marginTop: 2 },
    release: { color: t.textMuted, fontWeight: '600', fontSize: 13 },
  });
}
