import { useState, useRef, useEffect } from 'react'
import { emailsApi } from '../../api/client'

export function ContactField({
  label, value, onChange, contacts, placeholder
}: {
  label: string
  value: string
  onChange: (v: string) => void
  contacts: string[]
  placeholder?: string
}) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [activeIdx, setActiveIdx] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const lookupRef = useRef<number | null>(null)
  // Read inside the debounced callback to tell a stale response from a current
  // one without making the timer depend on `value`.
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => () => {
    if (lookupRef.current) window.clearTimeout(lookupRef.current)
  }, [])

  // Locally remembered addresses answer instantly; the server's ranked address
  // book — built from every indexed message, weighted by how often and how
  // recently you have written to someone — arrives a moment later and is
  // merged in. Typing never waits on the network.
  const localMatches = (needle: string) => contacts
    .filter(c => c.toLowerCase().includes(needle))
    .sort((a, b) => {
      const aPrefix = a.toLowerCase().startsWith(needle) ? 0 : 1
      const bPrefix = b.toLowerCase().startsWith(needle) ? 0 : 1
      return aPrefix - bPrefix // otherwise keep the store's recency order
    })

  const handleChange = (v: string) => {
    onChange(v)
    // Only autocomplete the last token (after the last comma)
    const lastToken = v.split(',').pop()?.trim() || ''

    if (lastToken.length < 1) {
      setSuggestions([])
      if (lookupRef.current) window.clearTimeout(lookupRef.current)
      return
    }

    const needle = lastToken.toLowerCase()
    setSuggestions(localMatches(needle).slice(0, 6))
    setActiveIdx(-1)

    if (lookupRef.current) window.clearTimeout(lookupRef.current)
    lookupRef.current = window.setTimeout(async () => {
      try {
        const found = await emailsApi.contacts(lastToken, { limit: 8 })
        // The request may land after the user has typed on; only apply it if
        // the field still ends with the token it was asked about.
        const current = (valueRef.current.split(',').pop() || '').trim().toLowerCase()
        if (current !== needle) return

        const formatted = found.map(c => (c.name ? `${c.name} <${c.email}>` : c.email))
        const merged: string[] = []
        const seen = new Set<string>()
        for (const entry of [...formatted, ...localMatches(needle)]) {
          const key = (entry.match(/<([^>]+)>/)?.[1] || entry).toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          merged.push(entry)
        }
        setSuggestions(merged.slice(0, 8))
      } catch {
        // Keep whatever the local list already offered.
      }
    }, 140)
  }

  const selectSuggestion = (suggestion: string) => {
    const parts = value.split(',')
    parts[parts.length - 1] = ' ' + suggestion
    onChange(parts.join(',').replace(/^,\s*/, '') + ', ')
    setSuggestions([])
    setActiveIdx(-1)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!suggestions.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (activeIdx >= 0) { e.preventDefault(); selectSuggestion(suggestions[activeIdx]) }
      else { setSuggestions([]) }
    } else if (e.key === 'Escape') { setSuggestions([]) }
  }

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setSuggestions([]) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} className="relative flex-1">
      <input
        type="text"
        value={value}
        onChange={e => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="w-full text-sm bg-transparent text-ink placeholder-ink-3 focus:outline-none"
      />
      {suggestions.length > 0 && (
        <div className="absolute left-0 top-full mt-1.5 w-64 glass-elevated rounded-xl z-50 py-1.5 max-h-48 overflow-y-auto animate-pop">
          {suggestions.map((s, i) => (
            <button
              key={s}
              onMouseDown={e => { e.preventDefault(); selectSuggestion(s) }}
              className={`w-full text-left px-3 py-1.5 text-xs truncate transition-colors ${
                i === activeIdx ? 'bg-surface-3 text-ink ' : 'text-ink hover:bg-surface-3 '
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
