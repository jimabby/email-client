import { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, Switch,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAppStore } from '../store';
import { api, errorMessage } from '../api';
import { useTheme, type ThemePreference } from '../ThemeContext';
import { radius, space, type Palette } from '../theme';
import type { Ui } from '../ui';
import { registerForPush, unregisterPush } from '../push';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function SettingsScreen({ navigation }: Props) {
  const { serverUrl, apiToken, setServerUrl, setApiToken } = useAppStore();
  const { t, ui, preference, setPreference } = useTheme();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);

  const [url, setUrl] = useState(serverUrl);
  const [token, setToken] = useState(apiToken);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (!serverUrl) return;
    api.aiSettings()
      .then(({ configured }) => setAiConfigured(configured))
      .catch(() => setAiConfigured(null));
  }, [serverUrl]);

  const save = async () => {
    await Promise.all([setServerUrl(url), setApiToken(token)]);
    setStatus({ ok: true, msg: 'Saved' });
  };

  const test = async () => {
    await Promise.all([setServerUrl(url), setApiToken(token)]);
    setTesting(true);
    setStatus(null);
    try {
      await api.health();
      setStatus({ ok: true, msg: 'Connected — backend is reachable.' });
    } catch (err) {
      setStatus({ ok: false, msg: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const togglePush = async (next: boolean) => {
    setPushBusy(true);
    try {
      if (next) {
        const registered = await registerForPush();
        setPushEnabled(!!registered);
        if (!registered) {
          setStatus({
            ok: false,
            msg: 'Could not enable notifications. Check that this is a physical device and that permission was granted.',
          });
        }
      } else {
        await unregisterPush();
        setPushEnabled(false);
      }
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20 }}>
      <Text style={styles.label}>Backend server URL</Text>
      <Text style={styles.help}>
        Enter the public HTTPS address of your Hermes backend.
      </Text>
      <TextInput
        value={url}
        onChangeText={setUrl}
        placeholder="https://mail.example.com"
        placeholderTextColor={t.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
      />

      <Text style={[styles.label, { marginTop: 20 }]}>API token</Text>
      <Text style={styles.help}>
        Use the same API_TOKEN configured on the cloud server. It is kept in the
        phone's encrypted credential storage.
      </Text>
      <TextInput
        value={token}
        onChangeText={setToken}
        placeholder="Paste your private API token"
        placeholderTextColor={t.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={styles.input}
      />

      <View style={styles.row}>
        <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={test} disabled={testing}>
          {testing ? (
            <ActivityIndicator color={t.text} />
          ) : (
            <Text style={styles.btnGhostText}>Test connection</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={save}>
          <Text style={styles.btnPrimaryText}>Save</Text>
        </TouchableOpacity>
      </View>

      {status && (
        <Text style={[styles.status, { color: status.ok ? t.success : t.danger }]}>
          {status.msg}
        </Text>
      )}

      {/* ─── Notifications ───────────────────────────────────────────────── */}
      <Text style={[styles.label, { marginTop: 28 }]}>Notifications</Text>
      <Text style={styles.help}>
        The backend watches every mailbox continuously. Turn this on and it will
        notify this device the moment mail arrives, even with the app closed.
      </Text>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>New mail notifications</Text>
        {pushBusy
          ? <ActivityIndicator color={t.accent} />
          : (
            <Switch
              value={pushEnabled}
              onValueChange={togglePush}
              trackColor={{ true: t.accent, false: t.bgInput }}
              thumbColor={t.bgElevated}
            />
          )}
      </View>

      {/* ─── Appearance ──────────────────────────────────────────────────── */}
      <Text style={[styles.label, { marginTop: 28 }]}>Appearance</Text>
      <Text style={styles.help}>
        Matches the desktop client. "System" follows your device setting.
      </Text>
      <View style={styles.segment}>
        {THEME_OPTIONS.map((option) => {
          const active = preference === option.value;
          return (
            <TouchableOpacity
              key={option.value}
              style={[styles.segmentItem, active && styles.segmentItemActive]}
              onPress={() => setPreference(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {option.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {aiConfigured !== null && (
        <Text style={styles.note}>
          {aiConfigured
            ? 'AI is configured on the server — summaries and smart replies are available when reading a message.'
            : 'No AI key is configured on the server, so summaries and smart replies are hidden. Add one in the desktop app under Settings → AI.'}
        </Text>
      )}

      {serverUrl ? (
        <TouchableOpacity
          style={[styles.btn, styles.btnPrimary, { marginTop: 28 }]}
          onPress={() => navigation.navigate('Accounts')}
        >
          <Text style={styles.btnPrimaryText}>Go to accounts</Text>
        </TouchableOpacity>
      ) : null}

      <Text style={styles.note}>
        The cloud backend stays online independently of your PC. For internet use,
        always use HTTPS and a long random API token.
      </Text>
    </ScrollView>
  );
}

function makeStyles(t: Palette, ui: Ui) {
  return StyleSheet.create({
    container: ui.screen,
    label: { ...ui.bodyStrong, marginBottom: 6 },
    help: { ...ui.secondary, marginBottom: space.md, lineHeight: 19 },
    input: ui.field,
    row: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
    btn: { flex: 1, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
    btnPrimary: { backgroundColor: t.accent },
    btnPrimaryText: ui.btnPrimaryText,
    btnGhost: { backgroundColor: t.bgInput, borderColor: t.border, borderWidth: StyleSheet.hairlineWidth },
    btnGhostText: { color: t.text, fontWeight: '600', fontSize: 15 },
    status: { marginTop: space.lg, fontSize: 14 },

    switchRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: t.bgElevated,
      borderColor: t.border, borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radius.md,
      paddingHorizontal: space.lg, paddingVertical: space.md,
      minHeight: 52,
    },
    switchLabel: { ...ui.body },

    segment: {
      flexDirection: 'row',
      backgroundColor: t.bgInput,
      borderRadius: radius.md,
      padding: 3,
      gap: 3,
    },
    segmentItem: { flex: 1, paddingVertical: 9, borderRadius: radius.sm, alignItems: 'center' },
    segmentItemActive: { backgroundColor: t.bgElevated },
    segmentText: { color: t.textMuted, fontSize: 14, fontWeight: '600' },
    segmentTextActive: { color: t.text },

    note: { ...ui.caption, marginTop: space.xl, lineHeight: 18 },
  });
}
