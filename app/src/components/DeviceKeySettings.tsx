import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, StyleSheet } from 'react-native';
import { errorMessage } from '../api';
import { importDeviceKey, listDeviceKeys, removeDeviceKey, lockDeviceKeys, type DeviceKeyInfo } from '../devicePgp';
import { useTheme } from '../ThemeContext';
import { radius, space } from '../theme';
import { useTr } from '../i18n';
import UnlockKey from './UnlockKey';

const grouped = (fp: string) => fp.replace(/(.{4})/g, '$1 ').trim();

/**
 * Settings → Encryption key on this phone. With a key here, the cloud backend
 * needs none: encrypted mail is opened, and encrypted replies are built, on
 * the phone.
 */
export function DeviceKeySettings() {
  const { t } = useTheme();
  const tr = useTr();
  const [keys, setKeys] = useState<DeviceKeyInfo[]>([]);
  const [armored, setArmored] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => { listDeviceKeys().then(setKeys).catch(e => setError(errorMessage(e))); }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const add = async () => {
    setBusy(true);
    try {
      setKeys(await importDeviceKey(armored, passphrase));
      setArmored(''); setPassphrase(''); setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = (email: string) => Alert.alert(
    tr('Remove the key for {email}?', { email }),
    tr('Encrypted mail to this address can no longer be opened on this phone. The copy on your desktop is not affected.'),
    [{ text: tr('Cancel'), style: 'cancel' }, { text: tr('Remove'), style: 'destructive', onPress: () => removeDeviceKey(email).then(refresh) }],
  );

  const fieldStyle = [styles.field, { color: t.text, backgroundColor: t.bgInput, borderColor: t.border }];
  const anyLocked = keys.some(k => !k.unlocked);

  return (
    <View style={{ gap: space.sm, marginTop: space.xl }}>
      <Text style={{ color: t.text, fontWeight: 'bold' }}>{tr('Encryption key on this phone')}</Text>
      <Text style={{ color: t.textMuted, lineHeight: 19 }}>
        {tr('Keep your OpenPGP key here instead of on the server. Encrypted mail is then opened and encrypted on this phone, and the server never sees it. On the desktop, use Settings → Encryption → Back up, paste the backup below with its passphrase, then delete the key from the cloud server.')}
      </Text>
      {keys.map(key => (
        <View key={key.email} style={[styles.card, { borderColor: t.border }]}>
          <Text style={{ color: t.text, fontWeight: '600' }}>{key.email}</Text>
          <Text style={{ color: t.textMuted, fontFamily: 'monospace', fontSize: 12 }} selectable>{grouped(key.fingerprint)}</Text>
          <View style={styles.row}>
            <Text style={{ color: key.unlocked ? t.success : t.textMuted, flex: 1 }}>{key.unlocked ? tr('Unlocked until the app closes') : tr('Locked')}</Text>
            <TouchableOpacity onPress={() => remove(key.email)} hitSlop={8}><Text style={{ color: t.danger }}>{tr('Remove')}</Text></TouchableOpacity>
          </View>
        </View>
      ))}
      {keys.length > 0 && (anyLocked
        ? <UnlockKey device onUnlocked={refresh} />
        : <TouchableOpacity onPress={() => { lockDeviceKeys(); refresh(); }}><Text style={{ color: t.accent }}>{tr('Lock now')}</Text></TouchableOpacity>)}

      <TextInput
        value={armored}
        onChangeText={setArmored}
        placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
        placeholderTextColor={t.textFaint}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={tr('Private key')}
        style={[fieldStyle, { minHeight: 90, textAlignVertical: 'top', fontFamily: 'monospace', fontSize: 12 }]}
      />
      <TextInput
        value={passphrase}
        onChangeText={setPassphrase}
        placeholder={tr('Key passphrase')}
        placeholderTextColor={t.textFaint}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={tr('Key passphrase')}
        style={fieldStyle}
      />
      <TouchableOpacity onPress={add} disabled={busy || !armored.trim() || !passphrase} style={[styles.button, { backgroundColor: t.accent, opacity: busy || !armored.trim() || !passphrase ? 0.5 : 1 }]}>
        <Text style={{ color: t.accentText, fontWeight: '700' }}>{tr('Add key to this phone')}</Text>
      </TouchableOpacity>
      {error && <Text style={{ color: t.danger }}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 9, fontSize: 15 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  button: { alignItems: 'center', paddingVertical: 11, borderRadius: radius.md },
});
