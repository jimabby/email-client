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
  const { serverUrl, setServerUrl } = useAppStore();
  const [url, setUrl] = useState(serverUrl);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const save = async () => {
    await setServerUrl(url);
    setStatus({ ok: true, msg: 'Saved' });
  };

  const test = async () => {
    await setServerUrl(url);
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
        Enter your computer's address on the same Wi-Fi network, including the
        port. Example: http://192.168.1.50:3001
      </Text>
      <TextInput
        value={url}
        onChangeText={setUrl}
        placeholder="http://192.168.1.50:3001"
        placeholderTextColor={theme.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
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
        Accounts are added on the desktop app. This mobile app reads from the same
        backend, so any account you've connected on desktop appears here.
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
