import { useEffect, useMemo, useRef, useState } from 'react'
import { useEmailStore } from '../store/emailStore'
import { readJson } from '../lib/storage'

interface Command {
  id: string
  label: string
  /** Shown dimmed on the right: the section, or a shortcut. */
  hint?: string
  /** Extra words that should match, beyond the label. */
  keywords?: string
  run: () => void
}

interface SavedSearch {
  id: string
  name: string
  query: string
  [key: string]: unknown
}

/** Every query word must appear in the label or keywords; earlier hits rank higher. */
function score(command: Command, query: string): number {
  const haystack = `${command.label} ${command.keywords || ''} ${command.hint || ''}`.toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  let total = 0
  for (const word of words) {
    const at = haystack.indexOf(word)
    if (at === -1) return -1
    total += at === 0 || haystack[at - 1] === ' ' ? 0 : 5
    total += at / 100
  }
  return total
}

/**
 * Ctrl+K: jump anywhere and do anything from the keyboard — folders on every
 * account, saved searches, the modal surfaces, and the everyday actions.
 *
 * Navigation the sidebar and list own is requested through window events
 * (`hermes:open-folder`, `hermes:run-search`), the same way the rest of the
 * app talks to those components, so this file holds no copy of their logic.
 */
export function CommandPalette() {
  const store = useEmailStore()
  const {
    setShowCommandPalette, accounts, folders, currentAccountId,
    openCompose, setUnifiedView, setShowDraftsModal, setShowOutboxModal, setShowFollowupsModal,
    setShowRulesModal, setShowAccountModal, toggleTheme, toggleChat,
  } = store
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const close = () => setShowCommandPalette(false)

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = []
    const openFolder = (accountId: string, folder: string) =>
      window.dispatchEvent(new CustomEvent('hermes:open-folder', { detail: { accountId, folder } }))

    list.push({ id: 'compose', label: 'New message', hint: 'Ctrl+N', keywords: 'compose write email', run: () => openCompose() })
    list.push({ id: 'unified', label: 'All inboxes', hint: 'Go to', keywords: 'unified inbox every account', run: () => setUnifiedView(true) })

    for (const account of accounts) {
      list.push({ id: `inbox:${account.id}`, label: `Inbox — ${account.email}`, hint: 'Go to', run: () => openFolder(account.id, 'INBOX') })
      for (const folder of folders[account.id] || []) {
        if (folder.path === 'INBOX') continue
        list.push({
          id: `folder:${account.id}:${folder.path}`,
          label: `${folder.name} — ${account.email}`,
          hint: 'Folder',
          keywords: folder.path,
          run: () => openFolder(account.id, folder.path),
        })
      }
    }
    if (currentAccountId) {
      list.push({ id: 'starred', label: 'Starred', hint: 'Go to', run: () => openFolder(currentAccountId, '__starred__') })
      list.push({ id: 'snoozed', label: 'Snoozed', hint: 'Go to', run: () => openFolder(currentAccountId, '__snoozed__') })
    }

    for (const saved of readJson<SavedSearch[]>('hermes-saved-searches', [])) {
      list.push({
        id: `saved:${saved.id}`,
        label: saved.name || saved.query,
        hint: 'Saved search',
        keywords: saved.query,
        run: () => window.dispatchEvent(new CustomEvent('hermes:run-search', { detail: saved })),
      })
    }

    list.push(
      { id: 'drafts', label: 'Drafts', hint: 'Open', run: () => setShowDraftsModal(true) },
      { id: 'outbox', label: 'Outbox', hint: 'Open', keywords: 'queued scheduled failed', run: () => setShowOutboxModal(true) },
      { id: 'followups', label: 'Follow-ups', hint: 'Open', keywords: 'reminders no reply', run: () => setShowFollowupsModal(true) },
      { id: 'rules', label: 'Rules', hint: 'Open', keywords: 'filters automate', run: () => setShowRulesModal(true) },
      { id: 'settings', label: 'Settings', hint: 'Open', keywords: 'preferences accounts notifications vip quiet import export ai model', run: () => setShowAccountModal(true) },
      { id: 'refresh', label: 'Refresh list', hint: 'Action', keywords: 'reload sync', run: () => window.dispatchEvent(new CustomEvent('hermes:refresh-list')) },
      { id: 'theme', label: 'Change theme', hint: 'Action', keywords: 'dark light appearance', run: () => toggleTheme() },
      { id: 'assistant', label: 'AI assistant', hint: 'Action', keywords: 'chat ask', run: () => toggleChat() },
      { id: 'shortcuts', label: 'Keyboard shortcuts', hint: '?', keywords: 'help keys', run: () => window.dispatchEvent(new CustomEvent('hermes:toggle-shortcuts')) },
    )
    return list
  }, [accounts, folders, currentAccountId])

  const results = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) return commands
    const ranked = commands
      .map(command => ({ command, rank: score(command, trimmed) }))
      .filter(r => r.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map(r => r.command)
    // Whatever was typed can always be searched for, across every account.
    ranked.push({
      id: 'search',
      label: `Search all mail for “${trimmed}”`,
      hint: 'Search',
      run: () => window.dispatchEvent(new CustomEvent('hermes:run-search', {
        detail: {
          id: 'palette', name: trimmed, query: trimmed, mode: 'email', attachmentType: '',
          searchAll: true, accountId: null, folder: useEmailStore.getState().currentFolder, category: 'All',
        },
      })),
    })
    return ranked
  }, [commands, query])

  useEffect(() => { setActive(0) }, [query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const execute = (command?: Command) => {
    if (!command) return
    close()
    command.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); execute(results[active]) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[110] flex items-start justify-center pt-[12vh] p-4 animate-fade" onClick={close}>
      <div
        role="dialog"
        aria-label="Command palette"
        onClick={e => e.stopPropagation()}
        className="glass-elevated rounded-2xl w-full max-w-xl overflow-hidden animate-rise"
      >
        <div className="flex items-center gap-2.5 px-4 border-b border-line/50">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-ink-3 flex-shrink-0">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command, folder, or search…"
            aria-label="Command"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={results[active] ? `cmd-${active}` : undefined}
            className="flex-1 bg-transparent py-3.5 text-[14px] text-ink placeholder:text-ink-3 outline-none"
          />
          <kbd className="px-1.5 py-0.5 text-[10px] bg-ink/6 border border-line/50 rounded text-ink-3">Esc</kbd>
        </div>
        <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto py-1.5">
          {results.map((command, index) => (
            <button
              key={command.id}
              id={`cmd-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === active}
              onMouseMove={() => setActive(index)}
              onClick={() => execute(command)}
              className={`w-full flex items-center gap-3 px-4 py-2 text-left text-[13px] transition-colors
                ${index === active ? 'bg-accent/14 text-ink' : 'text-ink-2'}`}
            >
              <span className="flex-1 truncate">{command.label}</span>
              {command.hint && <span className="text-[11px] text-ink-3 flex-shrink-0">{command.hint}</span>}
            </button>
          ))}
          {!results.length && <p className="px-4 py-6 text-center text-[12.5px] text-ink-3">No matches</p>}
        </div>
      </div>
    </div>
  )
}
