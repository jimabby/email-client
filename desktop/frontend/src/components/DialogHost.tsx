import { useEffect, useRef, useState } from 'react'
import { t } from '../lib/i18n'

/**
 * In-app prompt and confirm dialogs.
 *
 * Electron does not implement `window.prompt` — it is one of the few DOM APIs
 * Chromium exposes that Electron deliberately leaves out. Three features were
 * built on it (new folder, rename folder, insert link in the composer) and all
 * three silently did nothing in the packaged app while working perfectly under
 * `npm run dev`, which runs in a real browser. `window.confirm` does work, but
 * a native OS alert in the middle of a glass UI reads as a different program.
 *
 * These are promise-based so the call sites keep their shape:
 *
 *     const name = await promptDialog({ title: 'New folder' })
 *     if (!name) return
 *
 * `<DialogHost />` is mounted once in App; the functions below reach it through
 * a module-level subscription rather than context, so they are callable from
 * event handlers deep in the tree without threading a hook through.
 */

interface PromptRequest {
  kind: 'prompt'
  title: string
  label?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  /** Mask the input — for a password. */
  secret?: boolean
}

interface ConfirmRequest {
  kind: 'confirm'
  title: string
  body?: string
  confirmLabel?: string
  danger?: boolean
}

interface ChoiceRequest {
  kind: 'choice'
  title: string
  body?: string
  choices: { value: string; label: string }[]
  defaultValue?: string
  /** An optional extra checkbox, e.g. "Apply to the whole domain". */
  toggle?: { label: string; defaultValue?: boolean }
  confirmLabel?: string
}

type Request = (PromptRequest | ConfirmRequest | ChoiceRequest) & { resolve: (value: string | null) => void }

let publish: ((request: Request) => void) | null = null

/** @returns the entered text, or null if the user cancelled. */
export function promptDialog(options: Omit<PromptRequest, 'kind'>): Promise<string | null> {
  return new Promise((resolve) => {
    // No host mounted (a unit test, an unmounted tree) — behave as a cancel
    // rather than hanging the caller's await forever.
    if (!publish) return resolve(null)
    publish({ kind: 'prompt', ...options, resolve })
  })
}

/** @returns true if confirmed. */
export function confirmDialog(options: Omit<ConfirmRequest, 'kind'>): Promise<boolean> {
  return new Promise((resolve) => {
    if (!publish) return resolve(false)
    publish({ kind: 'confirm', ...options, resolve: (value) => resolve(value !== null) })
  })
}

/** @returns the chosen value and the toggle's state, or null if cancelled. */
export function choiceDialog(options: Omit<ChoiceRequest, 'kind'>): Promise<{ value: string; toggle: boolean } | null> {
  return new Promise((resolve) => {
    if (!publish) return resolve(null)
    publish({
      kind: 'choice',
      ...options,
      resolve: (raw) => {
        if (raw === null) return resolve(null)
        try { resolve(JSON.parse(raw)) } catch { resolve(null) }
      },
    })
  })
}

export function DialogHost() {
  const [request, setRequest] = useState<Request | null>(null)
  const [value, setValue] = useState('')
  const [toggle, setToggle] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    publish = (next) => {
      setValue(next.kind === 'prompt' || next.kind === 'choice' ? next.defaultValue ?? '' : '')
      setToggle(next.kind === 'choice' ? next.toggle?.defaultValue === true : false)
      setRequest(next)
    }
    return () => { publish = null }
  }, [])

  // Focus and select on open, so typing a replacement name is one action.
  useEffect(() => {
    if (request?.kind !== 'prompt') return
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 20)
    return () => window.clearTimeout(timer)
  }, [request])

  if (!request) return null

  const close = (result: string | null) => {
    request.resolve(result)
    setRequest(null)
  }

  const isPrompt = request.kind === 'prompt'
  const isChoice = request.kind === 'choice'
  const confirmLabel = request.confirmLabel || (isPrompt || isChoice ? t('Save') : t('Confirm'))
  const danger = request.kind === 'confirm' && request.danger === true
  // An empty prompt is a cancel — every call site treats "" as "no answer".
  const canSubmit = (!isPrompt && !isChoice) || value.trim().length > 0
  const result = () => isChoice ? JSON.stringify({ value, toggle }) : isPrompt ? value.trim() : ''

  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[110] flex items-center justify-center animate-fade"
      onMouseDown={() => close(null)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onMouseDown={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.stopPropagation(); close(null) }
          if (e.key === 'Enter' && canSubmit) { e.stopPropagation(); close(result()) }
        }}
        className="glass-elevated rounded-2xl w-[min(90vw,22rem)] overflow-hidden animate-rise"
      >
        <div className="px-5 pt-4 pb-3">
          <h2 className="font-semibold text-[14.5px] text-ink tracking-[-0.01em]">{request.title}</h2>

          {isPrompt ? (
            <>
              {request.label && (
                <label htmlFor="hermes-dialog-input" className="block text-[12px] text-ink-2 mt-2">
                  {request.label}
                </label>
              )}
              <input
                id="hermes-dialog-input"
                ref={inputRef}
                type={request.secret ? 'password' : 'text'}
                autoComplete={request.secret ? 'current-password' : undefined}
                value={value}
                onChange={e => setValue(e.target.value)}
                placeholder={request.placeholder}
                className="field w-full mt-2.5 px-3 py-2 text-[13px]"
              />
            </>
          ) : request.kind === 'choice' ? (
            <>
              {request.body && <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">{request.body}</p>}
              <div role="radiogroup" aria-label={request.title} className="mt-2.5 grid grid-cols-2 gap-1.5">
                {request.choices.map(choice => (
                  <button
                    key={choice.value}
                    role="radio"
                    aria-checked={value === choice.value}
                    onClick={() => setValue(choice.value)}
                    className={`px-3 py-2 rounded-lg text-[12.5px] text-left transition-colors
                      ${value === choice.value ? 'bg-accent/16 text-accent-ink font-semibold shadow-[inset_0_0_0_1px_rgb(var(--accent)/0.22)]' : 'text-ink hover:bg-ink/6'}`}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
              {request.toggle && (
                <label className="flex items-center gap-2 mt-3 text-[12.5px] text-ink-2">
                  <input type="checkbox" checked={toggle} onChange={e => setToggle(e.target.checked)} />
                  {request.toggle.label}
                </label>
              )}
            </>
          ) : (
            request.body && <p className="text-[13px] text-ink-2 mt-2 leading-relaxed max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words">{request.body}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 pb-4">
          <button
            onClick={() => close(null)}
            className="btn-ghost px-3 py-1.5 rounded-lg text-[12.5px] font-medium"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={() => close(result())}
            disabled={!canSubmit}
            className={`px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold disabled:opacity-40 disabled:cursor-default
              ${danger ? 'bg-danger text-white hover:brightness-110' : 'btn-accent'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
