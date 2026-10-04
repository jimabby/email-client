import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { apiToken, setApiToken, setUnauthorizedHandler, verifyToken } from '../api/client'
import { HermesLogo } from './HermesLogo'
import { t } from '../lib/i18n'

/**
 * Stands in front of the app when the backend wants a token we do not have.
 *
 * On the desktop the server injects the token into the page for loopback
 * callers, so this never appears. It exists for the cloud deployment, where
 * that injection deliberately does not happen and the UI previously had no way
 * to authenticate — it served a full app that failed every request.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  // A backend running without API_TOKEN accepts everything, so start optimistic
  // and only demand a token once a request actually comes back 401.
  const [locked, setLocked] = useState(false)
  const [checking, setChecking] = useState(true)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const unlock = useCallback(() => setLocked(false), [])

  useEffect(() => {
    setUnauthorizedHandler(() => setLocked(true))
    return () => setUnauthorizedHandler(null)
  }, [])

  // One probe at startup so an unauthenticated session shows the prompt
  // immediately rather than after a wall of failed requests.
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const res = await fetch('/api/auth-check', {
          headers: apiToken() ? { Authorization: `Bearer ${apiToken()}` } : {},
        })
        if (active && res.status === 401) setLocked(true)
      } catch {
        // Network failure is not an auth failure — let the app load and show
        // its own offline handling.
      } finally {
        if (active) setChecking(false)
      }
    })()
    return () => { active = false }
  }, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const candidate = token.trim()
    if (!candidate) return

    setSubmitting(true)
    setError(null)
    try {
      if (await verifyToken(candidate)) {
        setApiToken(candidate)
        unlock()
      } else {
        setError(t('That token was rejected. Check it against API_TOKEN on the server.'))
      }
    } catch {
      setError(t('Could not reach the server. Check the address and try again.'))
    } finally {
      setSubmitting(false)
    }
  }

  if (checking && !locked) return null
  if (!locked) return <>{children}</>

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface px-6">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-7">
          <HermesLogo size={26} />
          <span className="text-[17px] font-semibold tracking-[-0.02em] text-ink">Hermes</span>
        </div>

        <h1 className="text-[19px] font-semibold text-ink tracking-[-0.02em] mb-2">
          {t('Enter your access token')}
        </h1>
        <p className="text-[13.5px] leading-relaxed text-ink-2 mb-5">
          {t('This server is password-protected. Paste the API_TOKEN from its configuration — the same one the mobile app uses.')}
        </p>

        <label className="block">
          <span className="sr-only">{t('API token')}</span>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={t('API token')}
            autoFocus
            autoComplete="current-password"
            className="field w-full px-3.5 py-2.5 text-[13.5px]"
          />
        </label>

        {error && (
          <p role="alert" className="mt-2.5 text-[12.5px] text-danger">{error}</p>
        )}

        <button
          type="submit"
          disabled={!token.trim() || submitting}
          className="btn-primary mt-4 w-full py-2.5 text-[13.5px] font-medium disabled:opacity-50"
        >
          {submitting ? t('Checking…') : t('Unlock')}
        </button>

        <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
          {t('The token is kept for this tab only and is cleared when you close it.')}
        </p>
      </form>
    </div>
  )
}
