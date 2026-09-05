import { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../ThemeContext';
import { radius, space, type Palette } from '../theme';
import type { Ui } from '../ui';

/**
 * A bottom sheet for picking one of several options.
 *
 * This exists because `Alert.alert` cannot do the job on Android: the platform
 * dialog has exactly three button slots (neutral / negative / positive) and
 * React Native silently drops anything past the third. Both the snooze menu
 * (four times plus Cancel) and the send-later menu (three times plus Cancel)
 * were losing a button on every Android device — and the one dropped was
 * whichever the author listed last.
 */

export interface SheetOption {
  label: string;
  /** Secondary text on the right, e.g. the resolved time. */
  detail?: string;
  destructive?: boolean;
  onPress: () => void;
}

interface Props {
  visible: boolean;
  title: string;
  options: SheetOption[];
  onClose: () => void;
}

export function ActionSheet({ visible, title, options, onClose }: Props) {
  const { t, ui } = useTheme();
  const styles = useMemo(() => makeStyles(t, ui), [t, ui]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Stops a tap inside the sheet from dismissing it. */}
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>{title}</Text>
          {options.map((option) => (
            <TouchableOpacity
              key={option.label}
              style={styles.row}
              onPress={() => { onClose(); option.onPress(); }}
              accessibilityRole="button"
            >
              <Text style={[styles.label, option.destructive && styles.destructive]}>
                {option.label}
              </Text>
              {!!option.detail && <Text style={styles.detail}>{option.detail}</Text>}
            </TouchableOpacity>
          ))}
          <View style={styles.divider} />
          <TouchableOpacity style={styles.cancel} onPress={onClose} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(t: Palette, ui: Ui) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: t.bgElevated,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      paddingTop: space.lg,
      paddingBottom: space.xxl,
      paddingHorizontal: space.lg,
    },
    title: { ...ui.overline, marginBottom: space.sm },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 14,
      gap: space.md,
    },
    label: { ...ui.body, flexShrink: 1 },
    destructive: { color: t.danger },
    detail: { ...ui.caption },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginVertical: space.sm },
    cancel: {
      marginTop: space.xs,
      paddingVertical: 13,
      alignItems: 'center',
      backgroundColor: t.bgInput,
      borderRadius: radius.md,
    },
    cancelText: { color: t.text, fontWeight: '600', fontSize: 15 },
  });
}
