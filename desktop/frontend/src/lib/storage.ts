/**
 * localStorage with quota handling.
 *
 * Drafts carry base64 attachments, so a single save can exceed the ~5 MB
 * origin quota. A raw setItem throws QuotaExceededError, and because these
 * writes happen inside zustand setters an uncaught throw takes the UI down
 * mid-edit. Every write goes through here instead: on quota failure the caller
 * gets told, and can shed the largest items and retry.
 */

export type WriteResult = { ok: true } | { ok: false; reason: 'quota' | 'unavailable'; error: unknown }

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  // Different engines report this differently; name is the reliable signal.
  return err.name === 'QuotaExceededError'
    || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || /quota/i.test(err.message)
}

export function writeJson(key: string, value: unknown): WriteResult {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: isQuotaError(err) ? 'quota' : 'unavailable', error: err }
  }
}

/**
 * Write a list, dropping items from the end until it fits.
 * @returns the list that was actually persisted.
 */
export function writeListWithinQuota<T>(key: string, items: T[]): { stored: T[]; dropped: number } {
  let candidate = items
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = writeJson(key, candidate)
    if (result.ok) return { stored: candidate, dropped: items.length - candidate.length }
    if (result.reason !== 'quota') break
    if (candidate.length <= 1) {
      // Even one item won't fit — give up rather than looping forever.
      writeJson(key, [])
      return { stored: [], dropped: items.length }
    }
    // Halve rather than shed one at a time: attachments are large and uneven.
    candidate = candidate.slice(0, Math.max(1, Math.floor(candidate.length / 2)))
  }
  return { stored: candidate, dropped: items.length - candidate.length }
}

/** Approximate bytes a value will occupy once serialised. */
export function approximateSize(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}
