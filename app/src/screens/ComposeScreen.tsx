import { useLayoutEffect, useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage } from '../api';
import { theme } from '../theme';
import { senderName, stripHtml } from '../utils';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Compose'>;

export default function ComposeScreen({ navigation, route }: Props) {
  const { account, replyTo, prefill } = route.params;

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

  const bodyHtml = () => `<p>${text.replace(/\n/g, '<br>')}</p>`;
  const isEmpty = () => !to.trim() && !cc.trim() && !bcc.trim() && !subject.trim() && !text.trim();

  const send = async () => {
    if (!to.trim() || !subject.trim()) {
      Alert.alert('Missing fields', 'Please fill in the recipient and subject.');
      return;
    }
    setSending(true);
    try {
      await api.send(account.id, {
        to: to.trim(),
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject: subject.trim(),
        text,
        html: bodyHtml(),
      });
      Alert.alert('Sent', 'Your email was sent.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (err) {
      Alert.alert('Failed to send', errorMessage(err));
    } finally {
      setSending(false);
    }
  };

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
          <ActivityIndicator color={theme.accent} />
        ) : (
          <TouchableOpacity onPress={send}>
            <Text style={styles.sendBtn}>Send</Text>
          </TouchableOpacity>
        ),
    });
  }, [navigation, to, cc, bcc, subject, text, sending]);

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
            placeholderTextColor={theme.textFaint}
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
                placeholderTextColor={theme.textFaint}
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
                placeholderTextColor={theme.textFaint}
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
            placeholderTextColor={theme.textFaint}
            style={styles.input}
          />
        </View>

        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Write your message…"
          placeholderTextColor={theme.textFaint}
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
            ? <ActivityIndicator color={theme.text} />
            : <Text style={styles.draftText}>Save draft</Text>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  sendBtn: { color: theme.accent, fontWeight: '700', fontSize: 15 },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    gap: 12,
  },
  label: { color: theme.textFaint, fontSize: 13, width: 56 },
  fromValue: { color: theme.textMuted, fontSize: 15, flex: 1 },
  input: { color: theme.text, fontSize: 15, flex: 1 },
  ccToggle: { color: theme.accent, fontSize: 13, fontWeight: '600' },
  draftBtn: {
    marginHorizontal: 16, marginTop: 8, marginBottom: 24,
    backgroundColor: theme.bgElevated, borderColor: theme.border, borderWidth: 1,
    borderRadius: 10, paddingVertical: 12, alignItems: 'center',
  },
  draftText: { color: theme.text, fontWeight: '600', fontSize: 15 },
  bodyInput: {
    color: theme.text,
    fontSize: 15,
    lineHeight: 22,
    padding: 16,
    minHeight: 220,
  },
  quote: {
    marginHorizontal: 16,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: theme.border,
  },
  quoteHeader: { color: theme.textFaint, fontSize: 12, marginBottom: 6 },
  quoteText: { color: theme.textMuted, fontSize: 13, lineHeight: 19 },
});
