import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator, RefreshControl, Alert, TextInput,
} from 'react-native';
import { api, errorMessage } from '../api';
import { useTheme } from '../ThemeContext';
import { space, type Palette } from '../theme';
import type { Ui } from '../ui';
import type { OutboxItem, OutboxStatus } from '../types';
import { useTr, tr as translate } from '../i18n';

// Sends are queued on the server, so a message composed on a flaky connection
// is retried rather than lost. This screen is where a stuck one surfaces.

const STATUS_LABEL: Record<OutboxStatus, string> = {
  uncertain: 'Delivery uncertain',
  pending: 'Queued',
  sending: 'Sending',
  retrying: 'Retrying',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function statusColor(t: Palette): Record<OutboxStatus, string> {
  return {
    uncertain: t.danger,
    pending: t.accent,
    sending: t.accent,
    retrying: t.accent,
    sent: t.success,
    failed: t.danger,
    cancelled: t.textMuted,
  };
}

export default function OutboxScreen() {
  const { t, ui } = useTheme();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);
  const colors = useMemo(() => statusColor(t), [t]);
  const tr = useTr();

  const editingId = useRef<string | null>(null);
  const [editing, setEditing] = useState<OutboxItem | null>(null);
  const [editTo, setEditTo] = useState('');
  const [editSubject, setEditSubject] = useState('');
  const [bodyEdited, setBodyEdited] = useState(false);
  const [editText, setEditText] = useState<string | undefined>();
  const [editAt, setEditAt] = useState('');
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.outbox());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Status changes happen on the server (retries, backoff) with no user action.
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (item: OutboxItem, action: 'retry' | 'cancel' | 'discard') => {
    if (action === 'retry' && item.status === 'uncertain') {
      Alert.alert(tr('Check Sent mail first'), tr('Retrying may send a duplicate. Only continue if you have checked Sent mail.'), [{ text: tr('Cancel') }, { text: tr('Retry anyway'), onPress: () => { api.retryOutbox(item.id, true).then(load).catch(e => Alert.alert(tr('Error'), errorMessage(e))); } }]);
      return;
    }
    try {
      if (action === 'retry') await api.retryOutbox(item.id);
      else if (action === 'cancel') await api.cancelOutbox(item.id);
      else await api.discardOutbox(item.id);
      await load();
    } catch (err) {
      Alert.alert(translate('Error'), errorMessage(err));
    }
  };

  if (loading) {
    return <ActivityIndicator color={t.accent} size="large" style={{ marginTop: 40 }} />;
  }

  return (
    <FlatList
      style={styles.container}
      data={items}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); load(); }}
          tintColor={t.accent}
        />
      }
      ListHeaderComponent={editing ? <View style={{ padding: 20, gap: 12 }}>
        <Text style={{ color: t.text }}>{tr('Edit / reschedule')}</Text>
        <TextInput accessibilityLabel="Recipient" style={{ color: t.text }} value={editTo} onChangeText={setEditTo} placeholder="Recipient" />
        <TextInput accessibilityLabel="Subject" style={{ color: t.text }} value={editSubject} onChangeText={setEditSubject} placeholder="Subject" />
        <TextInput accessibilityLabel="Message" multiline editable={editText !== undefined} style={{ color: t.text }} value={editText || ''} onChangeText={value => { setBodyEdited(true); setEditText(value); }} placeholder="Message (plain text)" />
        <TextInput accessibilityLabel="Send at" style={{ color: t.text }} value={editAt} onChangeText={setEditAt} placeholder="YYYY-MM-DD HH:mm (local time; empty = now)" />
        <TouchableOpacity onPress={async () => { try { await api.editOutbox(editing.id, { to: editTo, subject: editSubject, text: bodyEdited ? editText : undefined, sendAt: editAt ? new Date(editAt).toISOString() : undefined }); setEditing(null); await load(); } catch (e) { Alert.alert(tr('Error'), errorMessage(e)); } }}><Text style={{ color: t.accent }}>{tr('Save and queue')}</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => setEditing(null)}><Text style={{ color: t.text }}>{tr('Cancel')}</Text></TouchableOpacity>
      </View> : null}
      ListEmptyComponent={
        <Text style={styles.empty}>{error || tr('Nothing waiting to send.')}</Text>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowHeader}>
            <Text style={[styles.status, { color: colors[item.status] }]}>
              {STATUS_LABEL[item.status] ? tr(STATUS_LABEL[item.status]) : item.status}
            </Text>
            <Text style={styles.subject} numberOfLines={1}>{item.subject || tr('(no subject)')}</Text>
          </View>
          <Text style={styles.to} numberOfLines={1}>{tr('To')} {item.to || '—'}</Text>

          {item.status === 'retrying' && (
            <Text style={styles.detail}>
              {tr('Attempt {count} failed — will try again automatically', { count: item.attempts ?? 0 })}
            </Text>
          )}
          {(item.status === 'failed' || item.status === 'uncertain') && !!item.error && (
            <Text style={styles.errorText}>{item.error}</Text>
          )}

          {!!item.history?.length && <View><Text style={styles.detail}>{tr('Delivery history')}</Text>{item.history.map((event, index) => <Text key={index} style={styles.detail}>{new Date(event.at).toLocaleString()} - {event.status} {event.detail}</Text>)}</View>}
          <View style={styles.actions}>
            {['pending', 'retrying', 'failed', 'cancelled'].includes(item.status) && <TouchableOpacity onPress={() => { editingId.current = item.id; setEditing(item); setEditTo(item.to); setEditSubject(item.subject); setEditAt(''); setEditText(undefined); setBodyEdited(false); api.outboxDetail(item.id).then(d => { if (editingId.current === item.id) setEditText(d.email?.text || '') }).catch(e => Alert.alert(tr('Error'), errorMessage(e))); }}><Text style={styles.action}>{tr('Edit / reschedule')}</Text></TouchableOpacity>}
            {(item.status === 'failed' || item.status === 'uncertain') && (
              <TouchableOpacity onPress={() => act(item, 'retry')}>
                <Text style={styles.action}>{tr('Retry now')}</Text>
              </TouchableOpacity>
            )}
            {(item.status === 'pending' || item.status === 'retrying' || item.status === 'failed') && (
              <TouchableOpacity onPress={() => act(item, 'cancel')}>
                <Text style={styles.action}>{tr('Cancel')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => act(item, 'discard')}>
              <Text style={[styles.action, styles.danger]}>{tr('Discard')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    />
  );
}

function makeStyles(t: Palette, ui: Ui) {
  return StyleSheet.create({
    container: ui.screen,
    empty: { ...ui.secondary, textAlign: 'center', marginTop: 48, paddingHorizontal: space.xl },
    row: {
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    rowHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    status: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
    subject: { ...ui.bodyStrong, flex: 1 },
    to: { ...ui.caption, marginTop: 2 },
    detail: { color: t.accent, fontSize: 12, marginTop: 4 },
    errorText: { color: t.danger, fontSize: 12, marginTop: 4 },
    actions: { flexDirection: 'row', gap: 18, marginTop: space.sm },
    action: { color: t.accent, fontSize: 13.5, fontWeight: '600' },
    danger: { color: t.danger },
  });
}
