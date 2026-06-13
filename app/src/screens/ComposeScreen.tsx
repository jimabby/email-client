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
  const { account, replyTo } = route.params;

  const [to, setTo] = useState(replyTo ? replyTo.from : '');
  const [subject, setSubject] = useState(
    replyTo ? `Re: ${replyTo.subject.replace(/^re:\s*/i, '')}` : ''
  );
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!to.trim() || !subject.trim()) {
      Alert.alert('Missing fields', 'Please fill in the recipient and subject.');
      return;
    }
    setSending(true);
    try {
      await api.send(account.id, {
        to: to.trim(),
        subject: subject.trim(),
        text,
        html: `<p>${text.replace(/\n/g, '<br>')}</p>`,
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
  }, [navigation, to, subject, text, sending]);

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
        </View>
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
