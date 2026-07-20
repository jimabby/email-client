import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAppStore } from '../store';
import { api, errorMessage } from '../api';
import { theme } from '../theme';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export default function SettingsScreen({ navigation }: Props) {
  const { serverUrl, apiToken, setServerUrl, setApiToken } = useAppStore();
  const [url, setUrl] = useState(serverUrl);
  const [token, setToken] = useState(apiToken);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

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
        placeholderTextColor={theme.textFaint}
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
        placeholderTextColor={theme.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={styles.input}
      />

      <View style={styles.row}>
        <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={test} disabled={testing}>
          {testing ? (
            <ActivityIndicator color={theme.text} />
          ) : (
            <Text style={styles.btnGhostText}>Test connection</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={save}>
          <Text style={styles.btnPrimaryText}>Save</Text>
        </TouchableOpacity>
      </View>

      {status && (
        <Text style={[styles.status, { color: status.ok ? theme.success : theme.danger }]}>
          {status.msg}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  label: { color: theme.text, fontWeight: '600', fontSize: 15, marginBottom: 6 },
  help: { color: theme.textMuted, fontSize: 13, marginBottom: 12, lineHeight: 18 },
  input: {
    backgroundColor: theme.bgInput,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 10,
    color: theme.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: theme.accent },
  btnPrimaryText: { color: theme.accentText, fontWeight: '700', fontSize: 15 },
  btnGhost: { backgroundColor: theme.bgInput, borderColor: theme.border, borderWidth: 1 },
  btnGhostText: { color: theme.text, fontWeight: '600', fontSize: 15 },
  status: { marginTop: 16, fontSize: 14 },
  note: { color: theme.textFaint, fontSize: 12, marginTop: 32, lineHeight: 17 },
});
