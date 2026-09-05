import { StyleSheet } from 'react-native';
import { makeType, radius, space, type Palette } from './theme';

/**
 * Shared styles, built for a palette.
 *
 * Every screen had its own copy of "a card", "a text field", "the primary
 * button", and "the centred empty state" — six slightly different versions of
 * each, which is why they had drifted apart. They live here once.
 *
 * This is a factory rather than a module-level StyleSheet because the palette
 * is now chosen at runtime: a static sheet baked the dark colours in at import
 * time, which is what made light mode impossible on the phone.
 */
export function makeUi(palette: Palette) {
  const type = makeType(palette);

  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: palette.bg },

    // A centred block for loading, error, and empty states.
    center: {
      flexGrow: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: space.xxl,
      backgroundColor: palette.bg,
    },

    // The standard surface: rounded, faintly outlined, floating on the ground.
    card: {
      backgroundColor: palette.bgElevated,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
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
      backgroundColor: palette.border,
      marginLeft: space.lg,
    },

    // Text entry.
    field: {
      backgroundColor: palette.bgInput,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      paddingHorizontal: space.md,
      paddingVertical: 11,
      color: palette.text,
      fontSize: 15,
    },
    fieldFocused: { borderColor: palette.accent },

    // Buttons.
    btnPrimary: {
      backgroundColor: palette.accent,
      borderRadius: radius.md,
      paddingHorizontal: space.xl,
      paddingVertical: 13,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnPrimaryText: { color: palette.accentText, fontWeight: '700', fontSize: 15 },

    btnSecondary: {
      backgroundColor: palette.bgInput,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      paddingHorizontal: space.lg,
      paddingVertical: 11,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnSecondaryText: { color: palette.text, fontWeight: '600', fontSize: 14 },

    btnDangerText: { color: palette.danger, fontWeight: '600', fontSize: 14 },

    // A header action, e.g. "Compose".
    headerAction: { color: palette.accent, fontWeight: '600', fontSize: 16 },

    // Round contact avatar.
    avatar: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
    avatarText: { color: '#fff', fontWeight: '600' },

    // Count badge.
    badge: {
      backgroundColor: palette.accent,
      borderRadius: radius.pill,
      minWidth: 20,
      paddingHorizontal: 6,
      paddingVertical: 2,
      alignItems: 'center',
    },
    badgeText: { color: palette.accentText, fontSize: 11, fontWeight: '700' },

    // Type ramp, so screens reference a name rather than a size.
    title: type.title,
    heading: type.heading,
    body: type.body,
    bodyStrong: type.bodyStrong,
    secondary: type.secondary,
    caption: type.caption,
    overline: type.overline,
  });
}

export type Ui = ReturnType<typeof makeUi>;

export { radius, space };
