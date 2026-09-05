import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance, type ColorSchemeName } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { darkPalette, lightPalette, type Palette } from './theme';
import { makeUi, type Ui } from './ui';

/**
 * Theme for the mobile app.
 *
 * The desktop client ships a complete light palette; the phone shipped only
 * the dark one, so the two products looked like different apps for anyone
 * whose device is in light mode. The preference matches the desktop's: follow
 * the system by default, with an explicit override available in Settings.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'hermes-theme';

interface ThemeValue {
  /** The active palette. */
  t: Palette;
  /** Shared component styles built for that palette. */
  ui: Ui;
  mode: ResolvedTheme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function resolve(preference: ThemePreference, system: ColorSchemeName): ResolvedTheme {
  if (preference !== 'system') return preference;
  return system === 'light' ? 'light' : 'dark';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [system, setSystem] = useState<ColorSchemeName>(Appearance.getColorScheme());

  // The stored preference arrives a tick after mount. Starting from 'system'
  // means the first frame already matches the device rather than flashing.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then(raw => {
        if (raw === 'light' || raw === 'dark' || raw === 'system') setPreferenceState(raw);
      })
      .catch(() => { /* a missing preference is just 'system' */ });
  }, []);

  // Under 'system' the OS can change the theme with no interaction at all, so
  // the listener is not optional.
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => setSystem(colorScheme));
    return () => subscription.remove();
  }, []);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => { /* best effort */ });
  };

  const value = useMemo<ThemeValue>(() => {
    const mode = resolve(preference, system);
    const t = mode === 'light' ? lightPalette : darkPalette;
    return { t, ui: makeUi(t), mode, preference, setPreference };
  }, [preference, system]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}
