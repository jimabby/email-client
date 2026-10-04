import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
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
import type { AiMode } from '../types';
import { useTr, tr as translate } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'Compose'>;

const AI_MODES: { mode: AiMode; label: string; needsText: boolean }[] = [
  { mode: 'reply', label: 'Draft a reply', needsText: false },
  { mode: 'improve', label: 'Improve writing', needsText: true },
  { mode: 'concise', label: 'Make it shorter', needsText: true },
  { mode: 'grammar', label: 'Fix grammar', needsText: true },
  { mode: 'formal', label: 'More formal', needsText: true },
  { mode: 'friendly', label: 'More friendly', needsText: true },
];

const FOLLOW_UP_CHOICES = [
  { days: 0, label: 'No reminder' },
  { days: 1, label: 'If no reply in 1 day' },
  { days: 3, label: 'If no reply in 3 days' },
  { days: 7, label: 'If no reply in 1 week' },
];

export default function ComposeScreen({ navigation, route }: Props) {
  const { account, replyTo, prefill } = route.params;
  const { t, ui } = useTheme();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);
  const tr = useTr();

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

  const [followUpDays, setFollowUpDays] = useState(0);
  const [followUpOpen, setFollowUpOpen] = useState(false);

  // Draft help. The previous text is kept so one tap puts it back.
  const [aiAvailable, setAiAvailable] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [beforeAi, setBeforeAi] = useState<string | null>(null);

  useEffect(() => {
    api.aiSettings().then(s => setAiAvailable(s.configured)).catch(() => setAiAvailable(false));
  }, []);

  const runAi = async (mode: AiMode) => {
    setAiBusy(true);
    try {
      const suggestion = await api.suggest({
        mode,
        subject,
        body: text,
        replyTo: replyTo
          ? { from: replyTo.from, subject: replyTo.subject, body: replyTo.snippet || '' }
          : undefined,
      });
      if (suggestion.trim()) {
        setBeforeAi(text);
        setText(suggestion.trim());
      }
    } catch (err) {
      Alert.alert(translate('AI could not help'), errorMessage(err));
    } finally {
      setAiBusy(false);
    }
  };

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
      { label: tr('In 1 hour'), at: new Date(now.getTime() + 3600 * 1000) },
      { label: tr('Tomorrow morning'), at: tomorrow },
      { label: tr('Monday morning'), at: nextWeek },
    ];
  };

  const dispatch = async (sendAt?: Date, confirmedNoSubject = false) => {
    if (!to.trim()) {
      Alert.alert(tr('Missing recipient'), tr('Add at least one recipient'));
      return;
    }
    // An empty subject is legal mail, just usually a mistake — ask, don't refuse.
    if (!subject.trim() && !confirmedNoSubject) {
      Alert.alert(tr('Send without a subject?'), tr('This message has no subject line.'), [
        { text: tr('Cancel'), style: 'cancel' },
        { text: tr('Send anyway'), onPress: () => { dispatch(sendAt, true); } },
      ]);
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
        followUpDays: followUpDays || undefined,
      });

      const when = sendAt
        ? tr('Scheduled for {when}.', { when: sendAt.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) })
        : tr('Sending in {seconds} seconds.', { seconds: UNDO_WINDOW_SEC });

      Alert.alert(tr('Queued'), when, [
        {
          text: tr('Undo'),
          style: 'destructive',
          onPress: async () => {
            try {
              await api.cancelSend(account.id, result.jobId);
              Alert.alert(tr('Recalled'), tr('The message was not sent. It is still in your outbox.'));
            } catch (err) {
              Alert.alert(tr('Too late'), errorMessage(err));
            }
          },
        },
        { text: tr('OK'), onPress: () => navigation.goBack() },
      ]);
    } catch (err) {
      Alert.alert(tr('Failed to send email'), errorMessage(err));
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
      Alert.alert(tr('Draft saved'), tr('Saved to your Drafts folder.'), [
        { text: tr('OK'), onPress: () => navigation.goBack() },
      ]);
    } catch (err) {
      Alert.alert(tr('Failed to save draft'), errorMessage(err));
    } finally {
      setSavingDraft(false);
    }
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      title: replyTo ? tr('Reply') : tr('New message'),
      headerRight: () =>
        sending ? (
          <ActivityIndicator color={t.accent} />
        ) : (
          <View style={styles.headerActions}>
            <TouchableOpacity onPress={() => setLaterOpen(true)} hitSlop={8}>
              <Text style={styles.laterBtn}>{tr('Later')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={send} hitSlop={8}>
              <Text style={styles.sendBtn}>{tr('Send')}</Text>
            </TouchableOpacity>
          </View>
        ),
    });
  }, [navigation, to, cc, bcc, subject, text, sending, followUpDays, styles, t, tr]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ padding: 0 }} keyboardShouldPersistTaps="handled">
        <View style={styles.fieldRow}>
          <Text style={styles.label}>{tr('From')}</Text>
          <Text style={styles.fromValue}>{account.email}</Text>
        </View>
        <View style={styles.fieldRow}>
          <Text style={styles.label}>{tr('To')}</Text>
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
              <Text style={styles.ccToggle}>{tr('Cc')}/{tr('Bcc')}</Text>
            </TouchableOpacity>
          )}
        </View>
        {showCcBcc && (
          <>
            <View style={styles.fieldRow}>
              <Text style={styles.label}>{tr('Cc')}</Text>
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
              <Text style={styles.label}>{tr('Bcc')}</Text>
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
          <Text style={styles.label}>{tr('Subject')}</Text>
          <TextInput
            value={subject}
            onChangeText={setSubject}
            placeholder={tr('Subject')}
            placeholderTextColor={t.textFaint}
            style={styles.input}
          />
        </View>

        <View style={styles.toolRow}>
          {aiAvailable && (
            <TouchableOpacity style={styles.tool} onPress={() => setAiOpen(true)} disabled={aiBusy}>
              {aiBusy
                ? <ActivityIndicator color={t.ai} size="small" />
                : <Text style={styles.toolAi}>✦ {tr('AI help')}</Text>}
            </TouchableOpacity>
          )}
          {beforeAi !== null && !aiBusy && (
            <TouchableOpacity style={styles.tool} onPress={() => { setText(beforeAi); setBeforeAi(null); }}>
              <Text style={styles.toolText}>{tr('Undo AI')}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.tool} onPress={() => setFollowUpOpen(true)}>
            <Text style={followUpDays ? styles.toolActive : styles.toolText}>
              {followUpDays ? tr('Remind in {days}d if no reply', { days: followUpDays }) : tr('Follow-up reminder')}
            </Text>
          </TouchableOpacity>
        </View>

        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={tr('Write your email…')}
          placeholderTextColor={t.textFaint}
          multiline
          textAlignVertical="top"
          style={styles.bodyInput}
        />

        {replyTo && (
          <View style={styles.quote}>
            <Text style={styles.quoteHeader}>
              {tr('On {date}, {sender} wrote:', { date: new Date(replyTo.date).toLocaleString(), sender: senderName(replyTo.from) })}
            </Text>
            <Text style={styles.quoteText} numberOfLines={8}>
              {replyTo.snippet || stripHtml(replyTo.subject)}
            </Text>
          </View>
        )}

        <TouchableOpacity style={styles.draftBtn} onPress={saveDraft} disabled={savingDraft}>
          {savingDraft
            ? <ActivityIndicator color={t.text} />
            : <Text style={styles.draftText}>{tr('Save draft')}</Text>}
        </TouchableOpacity>
      </ScrollView>

      <ActionSheet
        visible={laterOpen}
        title={tr('Send later')}
        onClose={() => setLaterOpen(false)}
        options={scheduleChoices().map((choice) => ({
          label: choice.label,
          detail: choice.at.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
          onPress: () => dispatch(choice.at),
        }))}
      />

      <ActionSheet
        visible={aiOpen}
        title={tr('AI help')}
        onClose={() => setAiOpen(false)}
        options={AI_MODES
          .filter(m => (m.mode === 'reply' ? !!replyTo : true))
          .map((m) => ({
            label: tr(m.label),
            detail: m.needsText && !text.trim() ? tr('write something first') : undefined,
            onPress: () => {
              if (m.needsText && !text.trim()) {
                Alert.alert(tr('Nothing to rewrite'), tr('Write a draft first, then ask AI to improve it.'));
                return;
              }
              runAi(m.mode);
            },
          }))}
      />

      <ActionSheet
        visible={followUpOpen}
        title={tr('Remind me')}
        onClose={() => setFollowUpOpen(false)}
        options={FOLLOW_UP_CHOICES.map((choice) => ({
          label: tr(choice.label),
          detail: choice.days === followUpDays ? '✓' : undefined,
          onPress: () => setFollowUpDays(choice.days),
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
    toolRow: {
      flexDirection: 'row', flexWrap: 'wrap', gap: space.sm,
      paddingHorizontal: space.lg, paddingTop: space.md,
    },
    tool: {
      paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill,
      backgroundColor: t.bgInput, minHeight: 30, justifyContent: 'center',
    },
    toolText: { color: t.textMuted, fontSize: 13, fontWeight: '600' },
    toolActive: { color: t.accent, fontSize: 13, fontWeight: '600' },
    toolAi: { color: t.ai, fontSize: 13, fontWeight: '600' },
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
