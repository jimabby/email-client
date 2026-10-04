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
import type { ScreenerGroup, ScreenerState } from '../types';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Screener'>;

/**
 * The phone's view of the sender screener: first-time senders waiting for one
 * decision each. Allowing a sender moves what they sent into the inbox and lets
 * future mail straight through; blocking bins it, now and later.
 */
export default function ScreenerScreen(_props: Props) {
  const { t, ui } = useTheme();
  const tr = useTr();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);

  const [state, setState] = useState<ScreenerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.screener());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (enabled: boolean) => {
    setBusy('toggle');
    try {
      await api.configureScreener({ enabled });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const decide = async (group: ScreenerGroup, decision: 'allow' | 'block', target = group.sender) => {
    setBusy(group.sender);
    try {
      const result = await api.decideSender(target, decision);
      if (result.failed) {
        Alert.alert(tr('Screener'), tr('{count} messages could not be moved. Try again later.', { count: result.failed }));
      }
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // Blocking is the destructive choice, so it asks — and offers the whole
  // domain, which is what a run of cold outreach usually calls for.
  const confirmBlock = (group: ScreenerGroup) => {
    const at = group.sender.indexOf('@');
    const domain = at > 0 ? group.sender.slice(at) : null;
    Alert.alert(
      tr('Block {sender}?', { sender: group.name || group.sender }),
      tr('Their waiting mail goes to the trash, and so will anything they send later.'),
      [
        { text: tr('Cancel'), style: 'cancel' },
        ...(domain ? [{ text: tr('Block all {domain}', { domain }), style: 'destructive' as const, onPress: () => decide(group, 'block', domain) }] : []),
        { text: tr('Block'), style: 'destructive', onPress: () => decide(group, 'block') },
      ],
    );
  };

  if (loading) return <View style={styles.center}><ActivityIndicator color={t.accent} size="large" /></View>;

  const header = (
    <View>
      <View style={styles.toggleRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.toggleTitle}>{tr('Screen first-time senders')}</Text>
          <Text style={styles.help}>
            {tr('Mail from first-time senders waits here instead of your inbox. Allow a sender once and their mail always comes straight through.')}
          </Text>
        </View>
        <Switch
          value={!!state?.enabled}
          onValueChange={toggle}
          disabled={busy === 'toggle' || !state}
          trackColor={{ true: t.accent, false: t.bgInput }}
        />
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {state?.errors.map(e => <Text key={e.accountId} style={styles.error}>{e.email}: {e.error}</Text>)}
    </View>
  );

  return (
    <FlatList
      style={styles.container}
      data={state?.enabled ? state.pending : []}
      keyExtractor={(g) => g.sender}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={t.accent} />}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>
            {state?.enabled ? tr('Nobody is waiting') : tr('The screener is off')}
          </Text>
          <Text style={styles.help}>
            {state?.enabled
              ? tr('Nobody is waiting. New senders will show up here.')
              : tr('Turn it on and everyone you have already exchanged mail with is approved automatically.')}
          </Text>
        </View>
      }
      renderItem={({ item }) => {
        const latest = item.emails[0];
        const isBusy = busy === item.sender;
        return (
          <View style={styles.row}>
            <View style={styles.rowTop}>
              <View style={[styles.avatar, { backgroundColor: t.accent }]}>
                <Text style={styles.avatarText}>{initials(item.name || item.sender)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>{item.name || item.sender}</Text>
                {!!item.name && <Text style={styles.meta} numberOfLines={1}>{item.sender}</Text>}
              </View>
              <Text style={styles.meta}>{relativeTime(item.latest)}</Text>
            </View>
            <Text style={styles.subject} numberOfLines={1}>{latest?.subject || tr('(no subject)')}</Text>
            {!!latest?.snippet && <Text style={styles.meta} numberOfLines={2}>{latest.snippet}</Text>}
            <View style={styles.actions}>
              <Text style={[styles.meta, { flex: 1 }]}>
                {tr(item.count === 1 ? '{count} message' : '{count} messages', { count: item.count })}
              </Text>
              {isBusy ? <ActivityIndicator color={t.accent} /> : (
                <>
                  <TouchableOpacity onPress={() => confirmBlock(item)} hitSlop={8}>
                    <Text style={styles.block}>{tr('Block')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.allow} onPress={() => decide(item, 'allow')}>
                    <Text style={styles.allowText}>{tr('Allow')}</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        );
      }}
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
    row: {
      paddingHorizontal: space.lg, paddingVertical: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border,
    },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
    avatar: { width: 36, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
    avatarText: { color: t.accentText, fontWeight: '700', fontSize: 13 },
    name: { ...ui.bodyStrong },
    subject: { ...ui.body, marginTop: space.sm },
    meta: { ...ui.caption, marginTop: 2 },
    actions: { flexDirection: 'row', alignItems: 'center', gap: space.lg, marginTop: space.sm },
    block: { color: t.danger, fontWeight: '600', fontSize: 14 },
    allow: { ...ui.btnPrimary, paddingVertical: 7, paddingHorizontal: space.lg },
    allowText: { ...ui.btnPrimaryText, fontSize: 14 },
  });
}
