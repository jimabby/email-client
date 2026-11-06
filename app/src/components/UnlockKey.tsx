import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { api, errorMessage } from '../api';
import { unlockDeviceKeys } from '../devicePgp';
import { useTheme } from '../ThemeContext';
import { space, radius } from '../theme';
import { useTr } from '../i18n';

/**
 * Passphrase field for a locked OpenPGP key: the key stored on this phone
 * (`device`), or the backend's. Either way the unlocked key lives only in
 * memory for a while; nothing stored changes.
 */
export default function UnlockKey({ onUnlocked, email, device = false }: { onUnlocked: () => void; email?: string; device?: boolean }) {
  const { t } = useTheme();
  const tr = useTr();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async () => {
    if (!passphrase) return;
    setBusy(true);
    try {
      if (device) await unlockDeviceKeys(passphrase);
      else await api.pgpUnlock(passphrase, email);
      setPassphrase('');
      setError(null);
      onUnlocked();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.row}>
      <TextInput
        value={passphrase}
        onChangeText={setPassphrase}
        placeholder={tr('Key passphrase')}
        placeholderTextColor={t.textFaint}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={unlock}
        accessibilityLabel={tr('Key passphrase')}
        style={[styles.input, { color: t.text, backgroundColor: t.bgInput, borderColor: t.border }]}
      />
      <TouchableOpacity onPress={unlock} disabled={busy || !passphrase} style={[styles.button, { backgroundColor: t.accent, opacity: busy || !passphrase ? 0.5 : 1 }]}>
        {busy ? <ActivityIndicator color={t.accentText} /> : <Text style={{ color: t.accentText, fontWeight: '700' }}>{tr('Unlock')}</Text>}
      </TouchableOpacity>
      {error && <Text style={[styles.error, { color: t.danger }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  input: { flex: 1, minWidth: 160, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 8, fontSize: 15 },
  button: { paddingHorizontal: space.lg, paddingVertical: 9, borderRadius: radius.md },
  error: { width: '100%', fontSize: 13 },
});
