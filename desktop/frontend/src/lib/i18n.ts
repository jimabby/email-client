import { useCallback } from 'react'
import { create } from 'zustand'
import { ZH } from '../../../../shared/i18n.zh'

/**
 * Interface language.
 *
 * Keys are the English source strings themselves (gettext style), so a string
 * nobody has translated yet still reads correctly — it simply stays English —
 * and the call site documents what it says. Placeholders are `{name}`.
 *
 *     const t = useT()
 *     t('Moved {count} emails to {folder}', { count: 3, folder: 'Receipts' })
 *
 * Event handlers outside React render use the plain `t()` export, which reads
 * the current language at call time.
 *
 * Note: never translate an aria-label or title that code looks up with a
 * selector — keyboard shortcuts find their buttons by `data-action` instead.
 */

export type Language = 'en' | 'zh'
export type LanguagePreference = 'system' | Language

const STORAGE_KEY = 'hermes-language'

const CATALOGS: Record<Language, Record<string, string>> = { en: {}, zh: ZH }

export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', zh: '简体中文' }

export function systemLanguage(): Language {
  try {
    const wanted = navigator.languages?.length ? navigator.languages : [navigator.language]
    return wanted.some(l => /^zh\b/i.test(String(l))) ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

function readPreference(): LanguagePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'en' || raw === 'zh' ? raw : 'system'
  } catch {
    return 'system'
  }
}

function resolve(preference: LanguagePreference): Language {
  return preference === 'system' ? systemLanguage() : preference
}

interface LanguageState {
  preference: LanguagePreference
  language: Language
  setPreference: (preference: LanguagePreference) => void
}

export const useLanguageStore = create<LanguageState>((set) => ({
  preference: readPreference(),
  language: resolve(readPreference()),
  setPreference: (preference) => {
    try {
      if (preference === 'system') localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, preference)
    } catch { /* private mode — the choice lasts this session */ }
    const language = resolve(preference)
    applyDocumentLanguage(language)
    set({ preference, language })
  },
}))

/**
 * Tag the app's content with its language — on #root, deliberately not on
 * <html>. With <html lang="zh-CN">, Chromium on Windows hands the language to
 * the input method while <body> has focus, and the IME swallowed the letter
 * keys every shortcut uses (j/k/r/e…). Tagging #root keeps screen readers and
 * CJK glyph selection correct, and text fields inside the app still get the
 * Chinese hint when typing.
 */
function applyDocumentLanguage(language: Language) {
  try {
    document.documentElement.lang = 'en'
    const root = document.getElementById('root')
    if (root) root.lang = language === 'zh' ? 'zh-CN' : 'en'
  } catch { /* no DOM */ }
}
applyDocumentLanguage(useLanguageStore.getState().language)

export function translate(language: Language, key: string, vars?: Record<string, string | number>): string {
  const template = CATALOGS[language][key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
}

/** Translate with the current language. For use outside render. */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(useLanguageStore.getState().language, key, vars)
}

/** Translate inside a component; re-renders when the language changes. */
export function useT() {
  const language = useLanguageStore(s => s.language)
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(language, key, vars),
    [language],
  )
}

/** `{count} email` / `{count} emails`, chosen by count. */
export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}
