import { StyleSheet } from 'react-native';
import { theme, radius, space, type } from './theme';

/**
 * Shared styles.
 *
 * Every screen had its own copy of "a card", "a text field", "the primary
 * button", and "the centred empty state" — six slightly different versions of
 * each, which is why they had drifted apart. They live here once.
 */
export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },

  // A centred block for loading, error, and empty states.
  center: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xxl,
    backgroundColor: theme.bg,
  },

  // The standard surface: rounded, faintly outlined, floating on the ground.
  card: {
    backgroundColor: theme.bgElevated,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    overflow: 'hidden',
  },

  // Rows inside a card are separated by hairlines, never by gaps.
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.md,
  },
  hairline: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border,
    marginLeft: space.lg,
  },

  // Text entry.
  field: {
    backgroundColor: theme.bgInput,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    paddingHorizontal: space.md,
    paddingVertical: 11,
    color: theme.text,
    fontSize: 15,
  },
  fieldFocused: { borderColor: theme.accent },

  // Buttons.
  btnPrimary: {
    backgroundColor: theme.accent,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimaryText: { color: theme.accentText, fontWeight: '700', fontSize: 15 },

  btnSecondary: {
    backgroundColor: theme.bgInput,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSecondaryText: { color: theme.text, fontWeight: '600', fontSize: 14 },

  btnDangerText: { color: theme.danger, fontWeight: '600', fontSize: 14 },

  // A header action, e.g. "Compose".
  headerAction: { color: theme.accent, fontWeight: '600', fontSize: 16 },

  // Round contact avatar.
  avatar: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  avatarText: { color: '#fff', fontWeight: '600' },

  // Count badge.
  badge: {
    backgroundColor: theme.accent,
    borderRadius: radius.pill,
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignItems: 'center',
  },
  badgeText: { color: theme.accentText, fontSize: 11, fontWeight: '700' },

  // Type ramp, so screens reference a name rather than a size.
  title: type.title,
  heading: type.heading,
  body: type.body,
  bodyStrong: type.bodyStrong,
  secondary: type.secondary,
  caption: type.caption,
  overline: type.overline,
});

export { theme, radius, space, type };
