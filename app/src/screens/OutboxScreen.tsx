import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { api, errorMessage } from '../api';
import { useTheme } from '../ThemeContext';
import { space, type Palette } from '../theme';
import type { Ui } from '../ui';
import type { OutboxItem, OutboxStatus } from '../types';

// Sends are queued on the server, so a message composed on a flaky connection
// is retried rather than lost. This screen is where a stuck one surfaces.

const STATUS_LABEL: Record<OutboxStatus, string> = {
  pending: 'Queued',
  sending: 'Sending',
  retrying: 'Retrying',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function statusColor(t: Palette): Record<OutboxStatus, string> {
  return {
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
    try {
      if (action === 'retry') await api.retryOutbox(item.id);
      else if (action === 'cancel') await api.cancelOutbox(item.id);
      else await api.discardOutbox(item.id);
      await load();
    } catch (err) {
      Alert.alert('Error', errorMessage(err));
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
      ListEmptyComponent={
        <Text style={styles.empty}>{error || 'Nothing waiting to send.'}</Text>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowHeader}>
            <Text style={[styles.status, { color: colors[item.status] }]}>
              {STATUS_LABEL[item.status] ?? item.status}
            </Text>
            <Text style={styles.subject} numberOfLines={1}>{item.subject || '(no subject)'}</Text>
          </View>
          <Text style={styles.to} numberOfLines={1}>To {item.to || '—'}</Text>

          {item.status === 'retrying' && (
            <Text style={styles.detail}>
              Attempt {item.attempts} failed — will try again automatically
            </Text>
          )}
          {item.status === 'failed' && !!item.error && (
            <Text style={styles.errorText}>{item.error}</Text>
          )}

          <View style={styles.actions}>
            {item.status === 'failed' && (
              <TouchableOpacity onPress={() => act(item, 'retry')}>
                <Text style={styles.action}>Retry now</Text>
              </TouchableOpacity>
            )}
            {(item.status === 'pending' || item.status === 'retrying' || item.status === 'failed') && (
              <TouchableOpacity onPress={() => act(item, 'cancel')}>
                <Text style={styles.action}>Cancel</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => act(item, 'discard')}>
              <Text style={[styles.action, styles.danger]}>Discard</Text>
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
