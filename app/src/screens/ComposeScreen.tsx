import { useLayoutEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage } from '../api';
import { useTheme } from '../ThemeContext';
import { radius, space, type Palette } from '../theme';
import type { Ui } from '../ui';
import { ActionSheet } from '../components/ActionSheet';
import { senderName, stripHtml } from '../utils';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Compose'>;

export default function ComposeScreen({ navigation, route }: Props) {
  const { account, replyTo, prefill } = route.params;
  const { t, ui } = useTheme();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);

  const [to, setTo] = useState(replyTo ? replyTo.from : prefill?.to ?? '');
  const [cc, setCc] = useState(prefill?.cc ?? '');
  const [bcc, setBcc] = useState(prefill?.bcc ?? '');
  const [showCcBcc, setShowCcBcc] = useState(!!(prefill?.cc || prefill?.bcc));
  const [subject, setSubject] = useState(
    replyTo ? `Re: ${replyTo.subject.replace(/^re:\s*/i, '')}` : prefill?.subject ?? ''
  );
  const [text, setText] = useState(prefill?.body ?? '');
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);

  const bodyHtml = () => `<p>${text.replace(/\n/g, '<br>')}</p>`;
  const isEmpty = () => !to.trim() && !cc.trim() && !bcc.trim() && !subject.trim() && !text.trim();

  // The desktop holds a message briefly before it goes, so a misdirected reply
  // can still be caught. The server has always accepted the same parameters;
  // the phone simply never sent them.
  const UNDO_WINDOW_SEC = 10;

  const scheduleChoices = () => {
    const now = new Date();
    const at = (base: Date, hour: number) => {
      const d = new Date(base);
      d.setHours(hour, 0, 0, 0);
      return d;
    };
    const tomorrow = at(new Date(now.getTime() + 86400000), 8);
    const nextWeek = (() => {
      const d = at(now, 8);
      const add = ((1 - d.getDay()) + 7) % 7 || 7;
      d.setDate(d.getDate() + add);
      return d;
    })();
    return [
      { label: 'In 1 hour', at: new Date(now.getTime() + 3600 * 1000) },
      { label: 'Tomorrow morning', at: tomorrow },
      { label: 'Monday morning', at: nextWeek },
    ];
  };

  const dispatch = async (sendAt?: Date) => {
    if (!to.trim() || !subject.trim()) {
      Alert.alert('Missing fields', 'Please fill in the recipient and subject.');
      return;
    }
    setSending(true);
    try {
      const result = await api.send(account.id, {
        to: to.trim(),
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject: subject.trim(),
        text,
        html: bodyHtml(),
        replyToEmailId: replyTo?.id,
        replyToFolder: replyTo?.folder,
        sendAt: sendAt?.toISOString(),
        undoWindowSec: sendAt ? 0 : UNDO_WINDOW_SEC,
      });

      const when = sendAt
        ? `Scheduled for ${sendAt.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`
        : `Sending in ${UNDO_WINDOW_SEC} seconds.`;

      Alert.alert('Queued', when, [
        {
          text: 'Undo',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.cancelSend(account.id, result.jobId);
              Alert.alert('Recalled', 'The message was not sent. It is still in your outbox.');
            } catch (err) {
              Alert.alert('Too late', errorMessage(err));
            }
          },
        },
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (err) {
      Alert.alert('Failed to send', errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const send = () => dispatch();

  const saveDraft = async () => {
    if (isEmpty()) { navigation.goBack(); return; }
    setSavingDraft(true);
    try {
      await api.saveDraft(account.id, {
        to: to.trim(),
        cc: cc.trim(),
        bcc: bcc.trim(),
        subject: subject.trim(),
        text,
        html: bodyHtml(),
      });
      Alert.alert('Draft saved', 'Saved to your Drafts folder.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (err) {
      Alert.alert('Failed to save draft', errorMessage(err));
    } finally {
      setSavingDraft(false);
    }
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      title: replyTo ? 'Reply' : 'New message',
      headerRight: () =>
        sending ? (
          <ActivityIndicator color={t.accent} />
        ) : (
          <View style={styles.headerActions}>
            <TouchableOpacity onPress={() => setLaterOpen(true)} hitSlop={8}>
              <Text style={styles.laterBtn}>Later</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={send} hitSlop={8}>
              <Text style={styles.sendBtn}>Send</Text>
            </TouchableOpacity>
          </View>
        ),
    });
  }, [navigation, to, cc, bcc, subject, text, sending, styles, t]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ padding: 0 }} keyboardShouldPersistTaps="handled">
        <View style={styles.fieldRow}>
          <Text style={styles.label}>From</Text>
          <Text style={styles.fromValue}>{account.email}</Text>
        </View>
        <View style={styles.fieldRow}>
          <Text style={styles.label}>To</Text>
          <TextInput
            value={to}
            onChangeText={setTo}
            placeholder="recipient@example.com"
            placeholderTextColor={t.textFaint}
            autoCapitalize="none"
            keyboardType="email-address"
            style={styles.input}
          />
          {!showCcBcc && (
            <TouchableOpacity onPress={() => setShowCcBcc(true)} hitSlop={8}>
              <Text style={styles.ccToggle}>Cc/Bcc</Text>
            </TouchableOpacity>
          )}
        </View>
        {showCcBcc && (
          <>
            <View style={styles.fieldRow}>
              <Text style={styles.label}>Cc</Text>
              <TextInput
                value={cc}
                onChangeText={setCc}
                placeholder="cc@example.com"
                placeholderTextColor={t.textFaint}
                autoCapitalize="none"
                keyboardType="email-address"
                style={styles.input}
              />
            </View>
            <View style={styles.fieldRow}>
              <Text style={styles.label}>Bcc</Text>
              <TextInput
                value={bcc}
                onChangeText={setBcc}
                placeholder="bcc@example.com"
                placeholderTextColor={t.textFaint}
                autoCapitalize="none"
                keyboardType="email-address"
                style={styles.input}
              />
            </View>
          </>
        )}
        <View style={styles.fieldRow}>
          <Text style={styles.label}>Subject</Text>
          <TextInput
            value={subject}
            onChangeText={setSubject}
            placeholder="Subject"
            placeholderTextColor={t.textFaint}
            style={styles.input}
          />
        </View>

        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Write your message…"
          placeholderTextColor={t.textFaint}
          multiline
          textAlignVertical="top"
          style={styles.bodyInput}
        />

        {replyTo && (
          <View style={styles.quote}>
            <Text style={styles.quoteHeader}>
              On {new Date(replyTo.date).toLocaleString()}, {senderName(replyTo.from)} wrote:
            </Text>
            <Text style={styles.quoteText} numberOfLines={8}>
              {replyTo.snippet || stripHtml(replyTo.subject)}
            </Text>
          </View>
        )}

        <TouchableOpacity style={styles.draftBtn} onPress={saveDraft} disabled={savingDraft}>
          {savingDraft
            ? <ActivityIndicator color={t.text} />
            : <Text style={styles.draftText}>Save draft</Text>}
        </TouchableOpacity>
      </ScrollView>

      <ActionSheet
        visible={laterOpen}
        title="Send later"
        onClose={() => setLaterOpen(false)}
        options={scheduleChoices().map((choice) => ({
          label: choice.label,
          detail: choice.at.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
          onPress: () => dispatch(choice.at),
        }))}
      />
    </KeyboardAvoidingView>
  );
}

function makeStyles(t: Palette, ui: Ui) {
  return StyleSheet.create({
    container: ui.screen,
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
    laterBtn: { ...ui.headerAction, color: t.textMuted },
    sendBtn: ui.headerAction,
    fieldRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.lg,
      paddingVertical: 13,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
      gap: space.md,
    },
    label: { color: t.textFaint, fontSize: 13.5, width: 52 },
    fromValue: { ...ui.body, color: t.textMuted, flex: 1 },
    input: { ...ui.body, flex: 1 },
    ccToggle: { color: t.accent, fontSize: 13.5, fontWeight: '600' },
    draftBtn: {
      ...ui.btnSecondary,
      marginHorizontal: space.lg,
      marginTop: space.md,
      marginBottom: space.xl,
    },
    draftText: ui.btnSecondaryText,
    bodyInput: {
      color: t.text,
      fontSize: 15,
      lineHeight: 23,
      padding: space.lg,
      minHeight: 240,
    },
    quote: {
      marginHorizontal: space.lg,
      paddingLeft: space.md,
      borderLeftWidth: 2,
      borderLeftColor: t.border,
    },
    quoteHeader: { ...ui.caption, marginBottom: 6 },
    quoteText: { color: t.textMuted, fontSize: 13, lineHeight: 20 },
  });
}
