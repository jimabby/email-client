import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, StyleSheet, Switch } from 'react-native';
import { errorMessage } from '../api';
import { importDeviceKey, listDeviceKeys, removeDeviceKey, lockDeviceKeys, type DeviceKeyInfo } from '../devicePgp';
import { useTheme } from '../ThemeContext';
import { radius, space } from '../theme';
import { useTr } from '../i18n';
import UnlockKey from './UnlockKey';
import { isIndexEnabled, setIndexEnabled, indexedCount, clearIndex } from '../privateIndex';

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

  const [indexOn, setIndexOn] = useState(true);
  const [indexed, setIndexed] = useState(0);

  const refresh = useCallback(() => {
    listDeviceKeys().then(setKeys).catch(e => setError(errorMessage(e)));
    isIndexEnabled().then(setIndexOn);
    indexedCount().then(setIndexed);
  }, []);
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
    [{ text: tr('Cancel'), style: 'cancel' }, { text: tr('Remove'), style: 'destructive', onPress: async () => {
      await removeDeviceKey(email);
      // With no key left, nothing it decrypted should stay readable here.
      if (!(await listDeviceKeys()).length) await clearIndex().catch(() => {});
      refresh();
    } }],
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

      {keys.length > 0 && (
        <View style={[styles.card, { borderColor: t.border }]}>
          <View style={styles.row}>
            <Text style={{ color: t.text, flex: 1, fontWeight: '600' }}>{tr('Search encrypted mail on this phone')}</Text>
            <Switch
              value={indexOn}
              accessibilityLabel={tr('Search encrypted mail on this phone')}
              onValueChange={async on => { await setIndexEnabled(on).catch(e => setError(errorMessage(e))); refresh(); }}
            />
          </View>
          <Text style={{ color: t.textMuted, lineHeight: 19 }}>
            {tr('The server cannot search mail it cannot read. With this on, each encrypted message you open here is added to a search index kept encrypted on this phone. Only messages opened on this phone are covered.')}
          </Text>
          {indexOn && (
            <View style={styles.row}>
              <Text style={{ color: t.textMuted, flex: 1 }}>{tr('{count} messages indexed', { count: indexed })}</Text>
              {indexed > 0 && (
                <TouchableOpacity onPress={() => clearIndex().then(refresh)} hitSlop={8}><Text style={{ color: t.danger }}>{tr('Clear')}</Text></TouchableOpacity>
              )}
            </View>
          )}
        </View>
      )}

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
