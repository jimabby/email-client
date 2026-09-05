import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity,
  useWindowDimensions, Alert,
} from 'react-native';
import RenderHtml from 'react-native-render-html';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage, openAttachment, resolveArchiveFolder } from '../api';
import { sanitizeEmailHtml, totalBlocked } from '../emailHtml';
import { useTheme } from '../ThemeContext';
import { avatarColor, radius, space, type Palette } from '../theme';
import type { Ui } from '../ui';
import { ActionSheet } from '../components/ActionSheet';
import { initials, senderName, formatFullDate, stripHtml } from '../utils';
import type { EmailBody, ThreadSummary } from '../types';
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
    { label: 'This weekend', until: (() => { const d = at(now, 9); const add = ((6 - d.getDay()) + 7) % 7 || 7; d.setDate(d.getDate() + add); return d; })() },
    { label: 'Next week', until: nextWeek },
  ];
}

type Props = NativeStackScreenProps<RootStackParamList, 'Viewer'>;

export default function ViewerScreen({ navigation, route }: Props) {
  const { account, email } = route.params;
  const { width } = useWindowDimensions();
  const { t, ui } = useTheme();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);

  const [body, setBody] = useState<EmailBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starred, setStarred] = useState(!!email.starred);
  // Remote images stay blocked until the reader asks for them — loading one
  // confirms the address is live and hands the sender an IP and a timestamp.
  const [showRemoteImages, setShowRemoteImages] = useState(false);
  const [openingAttachment, setOpeningAttachment] = useState<number | null>(null);
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  // AI. The desktop reader has had smart replies and thread summary for a
  // while; a phone screen is where they earn the most, because scrolling a long
  // message to find the ask is the expensive part.
  const [aiReady, setAiReady] = useState(false);
  const [replies, setReplies] = useState<string[]>([]);
  const [repliesLoading, setRepliesLoading] = useState(false);
  const [summary, setSummary] = useState<ThreadSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const sanitized = useMemo(
    () => (body?.html ? sanitizeEmailHtml(body.html, showRemoteImages) : null),
    [body?.html, showRemoteImages],
  );

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

  useEffect(() => {
    api.aiSettings()
      .then(({ configured }) => setAiReady(configured))
      .catch(() => setAiReady(false));
  }, []);

  const plainBody = () => body?.text || (body?.html ? stripHtml(body.html) : '') || email.snippet || '';

  const loadReplies = async () => {
    setRepliesLoading(true);
    try {
      setReplies(await api.smartReplies({ from: email.from, subject: email.subject, body: plainBody() }));
    } catch (err) {
      Alert.alert('Could not suggest replies', errorMessage(err));
    } finally {
      setRepliesLoading(false);
    }
  };

  const loadSummary = async () => {
    setSummaryLoading(true);
    try {
      setSummary(await api.threadSummary({
        subject: email.subject,
        messages: [{ from: email.from, date: body?.date || email.date, body: plainBody() }],
      }));
    } catch (err) {
      Alert.alert('Could not summarise', errorMessage(err));
    } finally {
      setSummaryLoading(false);
    }
  };

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

  const applySnooze = async (until: Date) => {
    try {
      await api.snooze(account.id, email.id, until.toISOString(), email, email.folder);
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', errorMessage(err));
    }
  };

  const forward = () => {
    navigation.navigate('Compose', {
      account,
      prefill: {
        subject: `Fwd: ${email.subject.replace(/^fwd:\s*/i, '')}`,
        body: `\n\n---------- Forwarded message ----------\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${plainBody()}`,
      },
    });
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={toggleStar} hitSlop={8} accessibilityLabel={starred ? 'Unstar' : 'Star'}>
            <Text style={[styles.star, starred && styles.starOn]}>{starred ? '★' : '☆'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={markUnread} hitSlop={8} accessibilityLabel="Mark unread">
            <Text style={styles.headerIcon}>✉︎</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={remove} hitSlop={8} accessibilityLabel="Delete">
            <Text style={styles.trash}>🗑</Text>
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, starred, body, styles]);

  return (
    <>
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
          <ActivityIndicator color={t.accent} style={{ marginTop: 40 }} size="large" />
        ) : error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          <>
            {aiReady && (
              <View style={styles.aiBar}>
                <TouchableOpacity
                  style={styles.aiChip}
                  onPress={loadSummary}
                  disabled={summaryLoading}
                >
                  {summaryLoading
                    ? <ActivityIndicator color={t.ai} size="small" />
                    : <Text style={styles.aiChipText}>✦ Summarise</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.aiChip}
                  onPress={loadReplies}
                  disabled={repliesLoading}
                >
                  {repliesLoading
                    ? <ActivityIndicator color={t.ai} size="small" />
                    : <Text style={styles.aiChipText}>✦ Suggest replies</Text>}
                </TouchableOpacity>
              </View>
            )}

            {summary && (
              <View style={styles.aiCard}>
                <Text style={styles.aiCardTitle}>Summary</Text>
                <Text style={styles.aiCardBody}>{summary.summary}</Text>
                {summary.keyPoints.length > 0 && (
                  <>
                    <Text style={styles.aiCardHeading}>Key points</Text>
                    {summary.keyPoints.map((point, i) => (
                      <Text key={i} style={styles.aiBullet}>• {point}</Text>
                    ))}
                  </>
                )}
                {summary.actionItems.length > 0 && (
                  <>
                    <Text style={styles.aiCardHeading}>Action items</Text>
                    {summary.actionItems.map((item, i) => (
                      <Text key={i} style={styles.aiBullet}>• {item}</Text>
                    ))}
                  </>
                )}
              </View>
            )}

            {replies.length > 0 && (
              <View style={styles.replyRow}>
                {replies.map((reply, i) => (
                  <TouchableOpacity
                    key={i}
                    style={styles.replyChip}
                    onPress={() => navigation.navigate('Compose', {
                      account,
                      replyTo: email,
                      prefill: { body: reply },
                    })}
                  >
                    <Text style={styles.replyChipText}>{reply}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {sanitized ? (
              <View style={styles.bodyWrap}>
                {totalBlocked(sanitized.blocked) > 0 && (
                  <View style={styles.privacyNotice}>
                    <Text style={styles.privacyText}>
                      {[
                        sanitized.blocked.pixels
                          ? `${sanitized.blocked.pixels} tracking pixel${sanitized.blocked.pixels === 1 ? '' : 's'} removed`
                          : null,
                        sanitized.blocked.images
                          ? `${sanitized.blocked.images} remote image${sanitized.blocked.images === 1 ? '' : 's'} blocked`
                          : null,
                      ].filter(Boolean).join(' · ')}
                    </Text>
                    {sanitized.blocked.images > 0 && (
                      <TouchableOpacity onPress={() => setShowRemoteImages(true)} hitSlop={8}>
                        <Text style={styles.privacyAction}>Show images</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
                <RenderHtml
                  contentWidth={width - 32}
                  source={{ html: sanitized.html }}
                  baseStyle={{ color: t.text, fontSize: 15, lineHeight: 22 }}
                  tagsStyles={{
                    a: { color: t.accent },
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
          </>
        )}

        {body?.attachments && body.attachments.length > 0 && (
          <View style={styles.attachments}>
            <Text style={styles.attachTitle}>Attachments ({body.attachments.length})</Text>
            {body.attachments.map((a, i) => (
              <TouchableOpacity
                key={i}
                style={styles.attachRow}
                disabled={openingAttachment === i}
                // Opened through a single-use ticket rather than a URL carrying
                // the API token — see openAttachment.
                onPress={async () => {
                  setOpeningAttachment(i);
                  try {
                    await openAttachment(email.accountId, email.id, i, a.filename, email.folder);
                  } catch (err) {
                    Alert.alert('Could not open attachment', errorMessage(err));
                  } finally {
                    setOpeningAttachment(null);
                  }
                }}
              >
                <Text style={styles.attachName} numberOfLines={1}>📎 {a.filename}</Text>
                <Text style={styles.attachSize}>
                  {openingAttachment === i ? 'Opening…' : `${Math.round((a.size || 0) / 1024)} KB`}
                </Text>
              </TouchableOpacity>
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
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setSnoozeOpen(true)}>
            <Text style={styles.secondaryText}>Snooze</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} onPress={archive}>
            <Text style={styles.secondaryText}>Archive</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/*
        A sheet, not Alert.alert. Android maps alert buttons onto the three
        native slots (neutral/negative/positive) and silently drops the rest, so
        four snooze choices plus Cancel lost a button on every Android device.
      */}
      <ActionSheet
        visible={snoozeOpen}
        title="Snooze until"
        onClose={() => setSnoozeOpen(false)}
        options={snoozeChoices().map((choice) => ({
          label: choice.label,
          detail: choice.until.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
          onPress: () => applySnooze(choice.until),
        }))}
      />
    </>
  );
}

function makeStyles(t: Palette, ui: Ui) {
  return StyleSheet.create({
    container: ui.screen,
    headerActions: { flexDirection: 'row', gap: 18, alignItems: 'center' },
    star: { color: t.textMuted, fontSize: 22 },
    starOn: { color: t.accent },
    headerIcon: { color: t.textMuted, fontSize: 18 },
    trash: { fontSize: 18 },

    header: {
      paddingHorizontal: space.lg,
      paddingTop: space.lg,
      paddingBottom: space.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    subject: { color: t.text, fontSize: 21, fontWeight: '700', letterSpacing: -0.4, marginBottom: space.lg, lineHeight: 27 },
    fromRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
    avatar: { width: 40, height: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
    avatarText: { color: '#fff', fontWeight: '600', fontSize: 14 },
    fromName: { ...ui.bodyStrong },
    date: { ...ui.caption, marginTop: 2 },

    aiBar: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md },
    aiChip: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      backgroundColor: t.bgInput,
      borderColor: t.border, borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.pill,
      paddingHorizontal: space.md, paddingVertical: 7,
      minHeight: 32,
    },
    aiChipText: { color: t.ai, fontSize: 12.5, fontWeight: '600' },

    aiCard: {
      marginHorizontal: space.lg, marginTop: space.md,
      backgroundColor: t.bgElevated,
      borderColor: t.border, borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.lg,
      padding: space.lg,
    },
    aiCardTitle: { ...ui.overline, color: t.ai, marginBottom: space.sm },
    aiCardBody: { ...ui.body, lineHeight: 21 },
    aiCardHeading: { ...ui.overline, marginTop: space.md, marginBottom: space.xs },
    aiBullet: { ...ui.secondary, lineHeight: 20 },

    replyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md },
    replyChip: {
      backgroundColor: t.accentSoft,
      borderRadius: radius.pill,
      paddingHorizontal: space.md, paddingVertical: 8,
    },
    replyChipText: { color: t.text, fontSize: 13 },

    bodyWrap: { paddingHorizontal: space.lg, paddingTop: space.lg },
    privacyNotice: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      gap: space.sm, marginBottom: space.md,
      backgroundColor: t.bgInput, borderRadius: radius.md,
      paddingHorizontal: space.md, paddingVertical: 9,
    },
    privacyText: { color: t.textMuted, fontSize: 12, flexShrink: 1 },
    privacyAction: { color: t.accent, fontSize: 12, fontWeight: '600' },
    plainBody: { color: t.text, fontSize: 15, lineHeight: 23, padding: space.lg },
    error: { ...ui.secondary, textAlign: 'center', marginTop: 40 },

    attachments: {
      marginHorizontal: space.lg,
      marginTop: space.xl,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border,
      paddingTop: space.lg,
    },
    attachTitle: { ...ui.overline, marginBottom: space.md },
    attachRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      backgroundColor: t.bgInput,
      borderColor: t.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.md,
      paddingHorizontal: space.md, paddingVertical: 11,
      marginBottom: space.sm, gap: space.sm,
    },
    attachName: { color: t.text, fontSize: 13.5, flex: 1 },
    attachSize: { ...ui.caption },

    actionBar: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.lg },
    replyBtn: ui.btnPrimary,
    replyText: ui.btnPrimaryText,
    secondaryBtn: ui.btnSecondary,
    secondaryText: ui.btnSecondaryText,
  });
}
