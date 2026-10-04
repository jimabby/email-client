import { useCallback } from 'react';
import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { ZH } from '../../shared/i18n.zh';

/**
 * Interface language for the phone.
 *
 * Same scheme as the desktop (desktop/frontend/src/lib/i18n.ts): keys are the
 * English text, the Chinese catalog lives in shared/ so both apps say the same
 * thing in the same words, and anything untranslated falls back to English.
 *
 * Named `tr` rather than `t` because `useTheme()` already hands every screen a
 * `t` — the colour palette.
 */

export type Language = 'en' | 'zh';
export type LanguagePreference = 'system' | Language;

const STORAGE_KEY = 'hermes-language';
const CATALOGS: Record<Language, Record<string, string>> = { en: {}, zh: ZH };

export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', zh: '简体中文' };

/** The device's preferred language, without a native localisation module. */
export function systemLanguage(): Language {
  const candidates: string[] = [];
  try {
    if (Platform.OS === 'ios') {
      const settings = NativeModules.SettingsManager?.settings;
      if (settings?.AppleLanguages?.length) candidates.push(...settings.AppleLanguages);
      if (settings?.AppleLocale) candidates.push(settings.AppleLocale);
    } else {
      const locale = NativeModules.I18nManager?.localeIdentifier;
      if (locale) candidates.push(locale);
    }
  } catch { /* fall through to Intl */ }
  try { candidates.push(Intl.DateTimeFormat().resolvedOptions().locale); } catch { /* no Intl */ }
  // iOS lists languages in preference order; the first known one wins.
  for (const raw of candidates) {
    const tag = String(raw || '').toLowerCase();
    if (/^zh\b|^zh[_-]/.test(tag)) return 'zh';
    if (/^en\b|^en[_-]/.test(tag)) return 'en';
  }
  return 'en';
}

const resolve = (preference: LanguagePreference): Language =>
  preference === 'system' ? systemLanguage() : preference;

interface LanguageState {
  preference: LanguagePreference;
  language: Language;
  setPreference: (preference: LanguagePreference) => void;
  /** Read the stored choice; called once at startup. */
  load: () => Promise<void>;
}

export const useLanguageStore = create<LanguageState>((set) => ({
  preference: 'system',
  language: resolve('system'),
  setPreference: (preference) => {
    set({ preference, language: resolve(preference) });
    (preference === 'system' ? AsyncStorage.removeItem(STORAGE_KEY) : AsyncStorage.setItem(STORAGE_KEY, preference))
      .catch(() => { /* the choice lasts this session */ });
  },
  load: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw === 'en' || raw === 'zh') set({ preference: raw, language: raw });
    } catch { /* stays on the system language */ }
  },
}));

export function translate(language: Language, key: string, vars?: Record<string, string | number>): string {
  const template = CATALOGS[language][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/** Translate with the current language. For use outside render (alerts, handlers). */
export function tr(key: string, vars?: Record<string, string | number>): string {
  return translate(useLanguageStore.getState().language, key, vars);
}

/** Translate inside a component; re-renders when the language changes. */
export function useTr() {
  const language = useLanguageStore((s) => s.language);
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(language, key, vars),
    [language],
  );
}
