import { useEffect, useRef, useState } from 'react'

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
}

interface ConfirmRequest {
  kind: 'confirm'
  title: string
  body?: string
  confirmLabel?: string
  danger?: boolean
}

type Request = (PromptRequest | ConfirmRequest) & { resolve: (value: string | null) => void }

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

export function DialogHost() {
  const [request, setRequest] = useState<Request | null>(null)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    publish = (next) => {
      setValue(next.kind === 'prompt' ? next.defaultValue ?? '' : '')
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
  const confirmLabel = request.confirmLabel || (isPrompt ? 'Save' : 'Confirm')
  const danger = !isPrompt && request.danger === true
  // An empty prompt is a cancel — every call site treats "" as "no answer".
  const canSubmit = !isPrompt || value.trim().length > 0

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
          if (e.key === 'Enter' && canSubmit) { e.stopPropagation(); close(isPrompt ? value.trim() : '') }
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
                value={value}
                onChange={e => setValue(e.target.value)}
                placeholder={request.placeholder}
                className="field w-full mt-2.5 px-3 py-2 text-[13px]"
              />
            </>
          ) : (
            request.body && <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">{request.body}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 pb-4">
          <button
            onClick={() => close(null)}
            className="btn-ghost px-3 py-1.5 rounded-lg text-[12.5px] font-medium"
          >
            Cancel
          </button>
          <button
            onClick={() => close(isPrompt ? value.trim() : '')}
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
