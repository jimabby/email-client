import { useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, Linking,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage } from '../api';
import { useTheme } from '../ThemeContext';
import { radius, space, type Palette } from '../theme';
import type { Ui } from '../ui';
import type { RootStackParamList } from '../navigation';
import { useTr } from '../i18n';

type Props = NativeStackScreenProps<RootStackParamList, 'AddAccount'>;

const PRESETS: { label: string; imapHost: string; smtpHost: string }[] = [
  { label: 'Gmail (app password)', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com' },
  { label: 'Outlook / Hotmail', imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com' },
  { label: 'Yahoo', imapHost: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com' },
  { label: 'iCloud', imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com' },
  { label: 'Other', imapHost: '', smtpHost: '' },
];

/**
 * Add an account, or reconnect one whose credentials stopped working.
 *
 * IMAP accounts are added here directly — the server tests the connection
 * before saving. Gmail and Outlook sign in through the provider's page in the
 * browser; the account appears in the list when you come back to the app.
 */
export default function AddAccountScreen({ navigation, route }: Props) {
  const reconnect = route.params?.reconnect;
  const { t, ui } = useTheme();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);
  const tr = useTr();

  const [preset, setPreset] = useState(0);
  const [email, setEmail] = useState(reconnect?.email || '');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState(PRESETS[0].imapHost);
  const [smtpHost, setSmtpHost] = useState(PRESETS[0].smtpHost);
  const [imapPort, setImapPort] = useState('993');
  const [smtpPort, setSmtpPort] = useState('587');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthStarted, setOauthStarted] = useState(false);

  const choosePreset = (index: number) => {
    setPreset(index);
    setImapHost(PRESETS[index].imapHost);
    setSmtpHost(PRESETS[index].smtpHost);
  };

  const signIn = async (provider: 'gmail' | 'outlook') => {
    setError(null);
    try {
      await Linking.openURL(await api.oauthUrl(provider));
      setOauthStarted(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (reconnect) {
        await api.updatePassword(reconnect.id, password);
      } else {
        await api.addImap({
          email: email.trim(),
          name: name.trim() || undefined,
          password,
          imapHost: imapHost.trim(),
          imapPort: Number(imapPort) || 993,
          imapSecure: true,
          smtpHost: smtpHost.trim(),
          smtpPort: Number(smtpPort) || 587,
          smtpSecure: Number(smtpPort) === 465,
        });
      }
      navigation.goBack();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // An OAuth account is reconnected by signing in to the same address again.
  if (reconnect && reconnect.type !== 'imap') {
    const provider = reconnect.type;
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ padding: space.xl }}>
        <Text style={styles.heading}>{tr('Sign in to {email} again', { email: reconnect.email })}</Text>
        <Text style={styles.help}>
          {tr("{provider} stopped accepting Hermes' access to this mailbox. Signing in again restores it; nothing else changes.", { provider: provider === 'gmail' ? 'Google' : 'Microsoft' })}
        </Text>
        <TouchableOpacity style={styles.primary} onPress={() => signIn(provider)}>
          <Text style={styles.primaryText}>{provider === 'gmail' ? tr('Sign in with Google') : tr('Sign in with Microsoft')}</Text>
        </TouchableOpacity>
        {oauthStarted && (
          <TouchableOpacity style={[styles.secondary, { marginTop: space.md }]} onPress={() => navigation.goBack()}>
            <Text style={styles.secondaryText}>{tr("I've signed in — back to accounts")}</Text>
          </TouchableOpacity>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    );
  }

  const canSubmit = reconnect
    ? !!password
    : !!(email.trim() && password && imapHost.trim() && smtpHost.trim());

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: space.xl }} keyboardShouldPersistTaps="handled">
      {!reconnect && (
        <>
          <Text style={styles.heading}>{tr('Sign in with your provider')}</Text>
          <View style={styles.row}>
            <TouchableOpacity style={[styles.secondary, { flex: 1 }]} onPress={() => signIn('gmail')}>
              <Text style={styles.secondaryText}>Google</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.secondary, { flex: 1 }]} onPress={() => signIn('outlook')}>
              <Text style={styles.secondaryText}>Microsoft</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.help}>
            {oauthStarted
              ? tr('Finish signing in in the browser, then come back — the account will appear in the list.')
              : tr('Opens the sign-in page in your browser. The server must have Google or Microsoft sign-in configured.')}
          </Text>

          <Text style={[styles.heading, { marginTop: space.xl }]}>{tr('Or connect by IMAP')}</Text>
          <View style={styles.chips}>
            {PRESETS.map((p, i) => (
              <TouchableOpacity
                key={p.label}
                style={[styles.chip, preset === i && styles.chipActive]}
                onPress={() => choosePreset(i)}
                accessibilityState={{ selected: preset === i }}
              >
                <Text style={[styles.chipText, preset === i && styles.chipTextActive]}>{tr(p.label)}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>{tr('Email address')}</Text>
          <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false}
            keyboardType="email-address" style={styles.input} placeholder="you@example.com" placeholderTextColor={t.textFaint} />
          <Text style={styles.label}>{tr('Display name (optional)')}</Text>
          <TextInput value={name} onChangeText={setName} style={styles.input} placeholderTextColor={t.textFaint} />
        </>
      )}

      {reconnect && (
        <>
          <Text style={styles.heading}>{tr('New password for {email}', { email: reconnect.email })}</Text>
          <Text style={styles.help}>
            {tr('The server stopped accepting the saved password. It is checked before it replaces the old one.')}
          </Text>
        </>
      )}

      <Text style={styles.label}>{preset === 0 && !reconnect ? tr('App password') : tr('Password')}</Text>
      <TextInput value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none"
        autoCorrect={false} style={styles.input} placeholderTextColor={t.textFaint} />

      {!reconnect && (
        <>
          <Text style={styles.label}>{tr('Incoming mail (IMAP)')}</Text>
          <View style={styles.row}>
            <TextInput value={imapHost} onChangeText={setImapHost} autoCapitalize="none" autoCorrect={false}
              style={[styles.input, { flex: 3 }]} placeholder="imap.example.com" placeholderTextColor={t.textFaint} />
            <TextInput value={imapPort} onChangeText={setImapPort} keyboardType="number-pad"
              style={[styles.input, { flex: 1 }]} accessibilityLabel={tr('Port')} />
          </View>
          <Text style={styles.label}>{tr('Outgoing mail (SMTP)')}</Text>
          <View style={styles.row}>
            <TextInput value={smtpHost} onChangeText={setSmtpHost} autoCapitalize="none" autoCorrect={false}
              style={[styles.input, { flex: 3 }]} placeholder="smtp.example.com" placeholderTextColor={t.textFaint} />
            <TextInput value={smtpPort} onChangeText={setSmtpPort} keyboardType="number-pad"
              style={[styles.input, { flex: 1 }]} accessibilityLabel={tr('Port')} />
          </View>
        </>
      )}

      <TouchableOpacity style={[styles.primary, { marginTop: space.xl }, !canSubmit && { opacity: 0.5 }]} onPress={submit} disabled={!canSubmit || busy}>
        {busy ? <ActivityIndicator color={t.accentText} /> : (
          <Text style={styles.primaryText}>{reconnect ? tr('Reconnect') : tr('Add account')}</Text>
        )}
      </TouchableOpacity>
      {busy && <Text style={styles.help}>{tr('Testing connection…')}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

function makeStyles(t: Palette, ui: Ui) {
  return StyleSheet.create({
    container: ui.screen,
    heading: { ...ui.heading, marginBottom: space.sm },
    label: { ...ui.bodyStrong, marginTop: space.lg, marginBottom: 6 },
    help: { ...ui.secondary, marginTop: space.sm, lineHeight: 19 },
    input: ui.field,
    row: { flexDirection: 'row', gap: space.sm },
    primary: ui.btnPrimary,
    primaryText: ui.btnPrimaryText,
    secondary: ui.btnSecondary,
    secondaryText: ui.btnSecondaryText,
    error: { color: t.danger, marginTop: space.lg, fontSize: 14, lineHeight: 20 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.sm },
    chip: {
      paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill,
      backgroundColor: t.bgInput, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    chipActive: { backgroundColor: t.accentSoft, borderColor: t.accent },
    chipText: { color: t.textMuted, fontSize: 13, fontWeight: '600' },
    chipTextActive: { color: t.text },
  });
}
