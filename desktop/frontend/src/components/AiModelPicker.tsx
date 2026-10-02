import { useEffect, useState } from 'react'
import { useEmailStore } from '../store/emailStore'
import { aiApi } from '../api/client'
import type { AiModelChoices, AiProvider } from '../types/email'

const CUSTOM = '__custom__'

/**
 * Which model the saved provider uses. Defaults to the fastest, cheapest one,
 * since nearly every call is a short per-message task; a bigger model writes
 * better drafts and summaries at a higher cost per call.
 */
export function AiModelPicker({ provider }: { provider: AiProvider }) {
  const { showNotification } = useEmailStore()
  const [choices, setChoices] = useState<AiModelChoices | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [custom, setCustom] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    aiApi.getModels().then(setChoices).catch(() => {})
    aiApi.getSettings().then(s => setCurrent(s.model)).catch(() => {})
  }, [provider])

  if (!choices) return null
  const options = choices.choices[provider] || []
  const isListed = !!current && options.some(o => o.id === current)
  const selectValue = current && !isListed ? CUSTOM : (current || choices.defaults[provider])

  const save = async (model: string | null) => {
    setSaving(true)
    try {
      const res = await aiApi.setModel(model)
      setCurrent(res.model)
      showNotification('success', `AI model set to ${res.model}`)
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Could not change the model')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <label className="block text-[10px] font-semibold text-ink-3 uppercase tracking-wide mb-1">Model</label>
      <select
        value={selectValue}
        disabled={saving}
        onChange={e => {
          const value = e.target.value
          if (value === CUSTOM) { setCustom(current && !isListed ? current : ''); setCurrent(CUSTOM); return }
          save(value === choices.defaults[provider] ? null : value)
        }}
        className="field w-full px-3 py-2 text-[13.5px]"
        aria-label="AI model"
      >
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        <option value={CUSTOM}>Other model id…</option>
      </select>
      {selectValue === CUSTOM && (
        <div className="flex gap-2 mt-2">
          <input
            value={custom}
            onChange={e => setCustom(e.target.value)}
            placeholder="exact model id"
            className="field flex-1 px-3 py-2 text-[13px] font-mono"
            aria-label="Custom model id"
          />
          <button
            onClick={() => custom.trim() && save(custom.trim())}
            disabled={saving || !custom.trim()}
            className="btn-accent px-3 py-2 rounded-xl text-[12px] font-semibold disabled:opacity-50"
          >
            Use
          </button>
        </div>
      )}
      <p className="mt-1.5 text-[10px] text-ink-2">
        Used for drafting, summaries, smart replies, categories, and the assistant. Larger models cost more per message.
      </p>
    </div>
  )
}
