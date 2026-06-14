import { useEffect, useLayoutEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity,
  useWindowDimensions, Alert,
} from 'react-native';
import RenderHtml from 'react-native-render-html';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage, resolveArchiveFolder } from '../api';
import { theme, avatarColor } from '../theme';
import { initials, senderName, formatFullDate, stripHtml } from '../utils';
import type { EmailBody } from '../types';
import type { RootStackParamList } from '../navigation';

// Quick snooze choices (mirrors the desktop viewer).
function snoozeChoices(): { label: string; until: Date }[] {
  const now = new Date();
  const at = (base: Date, h: number) => { const d = new Date(base); d.setHours(h, 0, 0, 0); return d; };
  const tomorrow = at(new Date(now.getTime() + 86400000), 8);
  const nextWeek = (() => { const d = at(now, 8); const add = ((1 - d.getDay()) + 7) % 7 || 7; d.setDate(d.getDate() + add); return d; })();
  return [
    { label: 'Later today', until: new Date(now.getTime() + 3 * 3600 * 1000) },
    { label: 'Tomorrow', until: tomorrow },
    { label: 'Next week', until: nextWeek },
  ];
}

type Props = NativeStackScreenProps<RootStackParamList, 'Viewer'>;

export default function ViewerScreen({ navigation, route }: Props) {
  const { account, email } = route.params;
  const { width } = useWindowDimensions();
  const [body, setBody] = useState<EmailBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starred, setStarred] = useState(!!email.starred);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const b = await api.getBody(account.id, email.id, email.folder);
        if (active) setBody(b);
        // Mark read on the server (best-effort; the list already shows it read).
        api.markRead(account.id, email.id, email.folder).catch(() => {});
      } catch (err) {
        if (active) setError(errorMessage(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [account.id, email.id, email.folder]);

  const toggleStar = async () => {
    const next = !starred;
    setStarred(next);
    try {
      await api.star(account.id, email.id, next, email.folder);
    } catch {
      setStarred(!next);
    }
  };

  const remove = () => {
    Alert.alert('Delete email', 'Move this email to trash?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(account.id, email.id, email.folder);
            navigation.goBack();
          } catch (err) {
            Alert.alert('Error', errorMessage(err));
          }
        },
      },
    ]);
  };

  const markUnread = async () => {
    try {
      await api.markUnread(account.id, email.id, email.folder);
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', errorMessage(err));
    }
  };

  const archive = async () => {
    try {
      const folders = await api.getFolders(account.id);
      await api.move(account.id, email.id, resolveArchiveFolder(folders), email.folder);
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', errorMessage(err));
    }
  };

  const snooze = () => {
    const choices = snoozeChoices();
    Alert.alert('Snooze until', undefined, [
      ...choices.map((c) => ({
        text: `${c.label} · ${c.until.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`,
        onPress: async () => {
          try {
            await api.snooze(account.id, email.id, c.until.toISOString(), email, email.folder);
            navigation.goBack();
          } catch (err) {
            Alert.alert('Error', errorMessage(err));
          }
        },
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const forward = () => {
    const quoted = body?.text || (body?.html ? stripHtml(body.html) : '') || email.snippet || '';
    navigation.navigate('Compose', {
      account,
      prefill: {
        subject: `Fwd: ${email.subject.replace(/^fwd:\s*/i, '')}`,
        body: `\n\n---------- Forwarded message ----------\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${quoted}`,
      },
    });
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={toggleStar} hitSlop={8}>
            <Text style={[styles.star, starred && styles.starOn]}>{starred ? '★' : '☆'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={markUnread} hitSlop={8}>
            <Text style={styles.headerIcon}>✉︎</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={remove} hitSlop={8}>
            <Text style={styles.trash}>🗑</Text>
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, starred, body]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.header}>
        <Text style={styles.subject}>{email.subject || '(no subject)'}</Text>
        <View style={styles.fromRow}>
          <View style={[styles.avatar, { backgroundColor: avatarColor(email.from) }]}>
            <Text style={styles.avatarText}>{initials(email.from)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.fromName}>{senderName(email.from)}</Text>
            <Text style={styles.date}>{formatFullDate(body?.date || email.date)}</Text>
          </View>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} size="large" />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : body?.html ? (
        <View style={styles.bodyWrap}>
          <RenderHtml
            contentWidth={width - 32}
            source={{ html: body.html }}
            baseStyle={{ color: theme.text, fontSize: 15, lineHeight: 22 }}
            tagsStyles={{
              a: { color: theme.accent },
              p: { marginVertical: 6 },
            }}
            defaultTextProps={{ selectable: true }}
          />
        </View>
      ) : body?.text ? (
        <Text style={styles.plainBody} selectable>{body.text}</Text>
      ) : (
        <Text style={styles.error}>No content</Text>
      )}

      {body?.attachments && body.attachments.length > 0 && (
        <View style={styles.attachments}>
          <Text style={styles.attachTitle}>Attachments ({body.attachments.length})</Text>
          {body.attachments.map((a, i) => (
            <View key={i} style={styles.attachRow}>
              <Text style={styles.attachName} numberOfLines={1}>📎 {a.filename}</Text>
              <Text style={styles.attachSize}>{Math.round((a.size || 0) / 1024)} KB</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.actionBar}>
        <TouchableOpacity
          style={styles.replyBtn}
          onPress={() => navigation.navigate('Compose', { account, replyTo: email })}
        >
          <Text style={styles.replyText}>Reply</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={forward}>
          <Text style={styles.secondaryText}>Forward</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={snooze}>
          <Text style={styles.secondaryText}>Snooze</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={archive}>
          <Text style={styles.secondaryText}>Archive</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  headerActions: { flexDirection: 'row', gap: 18, alignItems: 'center' },
  star: { color: theme.textMuted, fontSize: 22 },
  starOn: { color: theme.accent },
  headerIcon: { color: theme.textMuted, fontSize: 18 },
  trash: { fontSize: 18 },
  header: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  subject: { color: theme.text, fontSize: 19, fontWeight: '700', marginBottom: 14, lineHeight: 25 },
  fromRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  fromName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  date: { color: theme.textMuted, fontSize: 13, marginTop: 2 },
  bodyWrap: { paddingHorizontal: 16, paddingTop: 16 },
  plainBody: { color: theme.text, fontSize: 15, lineHeight: 22, padding: 16 },
  error: { color: theme.textMuted, textAlign: 'center', marginTop: 40, fontSize: 14 },
  attachments: { marginHorizontal: 16, marginTop: 20, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, paddingTop: 14 },
  attachTitle: { color: theme.textMuted, fontSize: 13, fontWeight: '600', marginBottom: 10 },
  attachRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: theme.bgElevated, borderColor: theme.border, borderWidth: 1,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8, gap: 10,
  },
  attachName: { color: theme.text, fontSize: 13, flex: 1 },
  attachSize: { color: theme.textFaint, fontSize: 12 },
  actionBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingTop: 16 },
  replyBtn: { backgroundColor: theme.accent, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 22, alignItems: 'center' },
  replyText: { color: theme.accentText, fontWeight: '700', fontSize: 15 },
  secondaryBtn: {
    backgroundColor: theme.bgElevated, borderColor: theme.border, borderWidth: 1,
    borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center',
  },
  secondaryText: { color: theme.text, fontWeight: '600', fontSize: 14 },
});
