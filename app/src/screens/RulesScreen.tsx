import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, Switch, Alert,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, errorMessage } from '../api';
import { useTheme } from '../ThemeContext';
import { radius, space, type Palette } from '../theme';
import type { Ui } from '../ui';
import type { MailRule, RuleActionType, RuleField } from '../types';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Rules'>;

const FIELDS: { value: RuleField; label: string }[] = [
  { value: 'fromAddress', label: 'Sender is' },
  { value: 'from', label: 'Sender contains' },
  { value: 'subject', label: 'Subject contains' },
  { value: 'to', label: 'To contains' },
];

const ACTIONS: { value: RuleActionType; label: string }[] = [
  { value: 'archive', label: 'Archive' },
  { value: 'markRead', label: 'Mark read' },
  { value: 'star', label: 'Star' },
  { value: 'spam', label: 'Spam' },
  { value: 'delete', label: 'Delete' },
];

const ACTION_LABEL: Record<string, string> = {
  move: 'move', archive: 'archive', markRead: 'mark read', markUnread: 'mark unread',
  star: 'star', spam: 'report spam', delete: 'delete',
};

/** One line describing a rule, e.g. "Subject contains "invoice" → archive". */
function describe(rule: MailRule): string {
  const join = rule.match === 'any' ? ' or ' : ' and ';
  const conditions = rule.conditions
    .map(c => `${c.field} ${c.op}${c.op === 'isTrue' ? '' : ` "${c.value}"`}`)
    .join(join);
  const actions = rule.actions.map(a => ACTION_LABEL[a.type] || a.type).join(', ');
  return `${conditions || 'no conditions'} → ${actions}`;
}

/**
 * The rule list, on the phone. Rules run on the server as mail arrives, so a
 * rule made here applies everywhere. Complex rules (several conditions, a
 * folder move) are shown and can be toggled or deleted; creating one here
 * covers the common single-condition case.
 */
export default function RulesScreen(_props: Props) {
  const { t, ui } = useTheme();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);

  const [rules, setRules] = useState<MailRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [field, setField] = useState<RuleField>('fromAddress');
  const [value, setValue] = useState('');
  const [action, setAction] = useState<RuleActionType>('archive');

  const load = useCallback(async () => {
    try {
      setRules(await api.rules());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const persist = async (next: MailRule[]) => {
    setSaving(true);
    try {
      setRules(await api.saveRules(next));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (rule: MailRule, enabled: boolean) =>
    persist(rules.map(r => (r.id === rule.id ? { ...r, enabled } : r)));

  const remove = (rule: MailRule) => {
    Alert.alert('Delete rule?', rule.name, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => persist(rules.filter(r => r.id !== rule.id)) },
    ]);
  };

  const add = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const fieldLabel = FIELDS.find(f => f.value === field)?.label || field;
    const actionLabel = ACTIONS.find(a => a.value === action)?.label || action;
    const rule: MailRule = {
      // The server assigns a real id to anything it has not seen.
      id: '',
      name: `${fieldLabel} ${trimmed} → ${actionLabel}`,
      enabled: true,
      match: 'all',
      conditions: [{ field, op: field === 'fromAddress' ? 'equals' : 'contains', value: trimmed.toLowerCase() }],
      actions: [{ type: action }],
    };
    const confirm = () => { persist([...rules, rule]); setValue(''); };
    if (action === 'delete' || action === 'spam') {
      Alert.alert('Create this rule?', `Every new message where ${fieldLabel.toLowerCase()} "${trimmed}" will be ${action === 'delete' ? 'deleted' : 'reported as spam'}.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Create', style: 'destructive', onPress: confirm },
      ]);
    } else {
      confirm();
    }
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={t.accent} size="large" /></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: space.lg }} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>New rule</Text>
      <View style={styles.chips}>
        {FIELDS.map(f => (
          <TouchableOpacity key={f.value} style={[styles.chip, field === f.value && styles.chipActive]} onPress={() => setField(f.value)}>
            <Text style={[styles.chipText, field === f.value && styles.chipTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <TextInput
        value={value}
        onChangeText={setValue}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={field === 'fromAddress' ? 'news@shop.com' : 'text to match'}
        placeholderTextColor={t.textFaint}
        style={styles.input}
      />
      <Text style={styles.then}>then</Text>
      <View style={styles.chips}>
        {ACTIONS.map(a => (
          <TouchableOpacity key={a.value} style={[styles.chip, action === a.value && styles.chipActive]} onPress={() => setAction(a.value)}>
            <Text style={[styles.chipText, action === a.value && styles.chipTextActive]}>{a.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <TouchableOpacity style={[styles.primary, !value.trim() && { opacity: 0.5 }]} onPress={add} disabled={!value.trim() || saving}>
        {saving ? <ActivityIndicator color={t.accentText} /> : <Text style={styles.primaryText}>Add rule</Text>}
      </TouchableOpacity>

      {error && <Text style={styles.error}>{error}</Text>}

      <Text style={[styles.heading, { marginTop: space.xl }]}>Your rules</Text>
      {!rules.length && <Text style={styles.help}>No rules yet. They run on the server as mail arrives.</Text>}
      <View style={rules.length ? styles.card : undefined}>
        {rules.map((rule, index) => (
          <View key={rule.id}>
            {index > 0 && <View style={styles.hairline} />}
            <View style={styles.ruleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.ruleName} numberOfLines={1}>{rule.name}</Text>
                <Text style={styles.ruleDetail} numberOfLines={2}>{describe(rule)}</Text>
                <TouchableOpacity onPress={() => remove(rule)} hitSlop={8}>
                  <Text style={styles.delete}>Delete</Text>
                </TouchableOpacity>
              </View>
              <Switch
                value={rule.enabled}
                onValueChange={(next) => toggle(rule, next)}
                trackColor={{ true: t.accent, false: t.bgInput }}
                thumbColor={t.bgElevated}
                disabled={saving}
              />
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function makeStyles(t: Palette, ui: Ui) {
  return StyleSheet.create({
    container: ui.screen,
    center: ui.center,
    heading: { ...ui.heading, marginBottom: space.sm },
    help: { ...ui.secondary, lineHeight: 19 },
    input: ui.field,
    then: { ...ui.secondary, marginVertical: space.sm },
    primary: { ...ui.btnPrimary, marginTop: space.md },
    primaryText: ui.btnPrimaryText,
    error: { color: t.danger, marginTop: space.md, fontSize: 14 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.sm },
    chip: {
      paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill,
      backgroundColor: t.bgInput, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border,
    },
    chipActive: { backgroundColor: t.accentSoft, borderColor: t.accent },
    chipText: { color: t.textMuted, fontSize: 13, fontWeight: '600' },
    chipTextActive: { color: t.text },
    card: ui.card,
    hairline: ui.hairline,
    ruleRow: { ...ui.cardRow, alignItems: 'flex-start', paddingVertical: space.md },
    ruleName: ui.bodyStrong,
    ruleDetail: { ...ui.caption, marginTop: 2, lineHeight: 17 },
    delete: { color: t.danger, fontSize: 13, fontWeight: '600', marginTop: space.sm },
  });
}
