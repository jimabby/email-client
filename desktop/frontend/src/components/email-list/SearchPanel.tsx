import type { Dispatch, SetStateAction } from 'react'
import { useT } from '../../lib/i18n'
import type { Account, EmailSummary } from '../../types/email'
import { SearchSection } from './SearchHistory'
import type { SearchEntry } from './SearchHistory'

type SearchMode = 'email' | 'attachment'

/** Everything the search header reads and changes. The state lives in
 *  EmailList, because it also decides what the list shows. */
export interface SearchPanelState {
  accounts: Account[]
  searchInput: string
  setSearchInput: Dispatch<SetStateAction<string>>
  searchMode: SearchMode
  setSearchMode: Dispatch<SetStateAction<SearchMode>>
  attachmentType: string
  setAttachmentType: Dispatch<SetStateAction<string>>
  searchAll: boolean
  setSearchAll: Dispatch<SetStateAction<boolean>>
  showSavedMenu: boolean
  setShowSavedMenu: Dispatch<SetStateAction<boolean>>
  setShowSearch: Dispatch<SetStateAction<boolean>>
  setSearchResults: (results: EmailSummary[] | null) => void
  handleSearch: (query: string, opts?: { accountId?: string | null; folder?: string; mode?: SearchMode; attachmentType?: string; searchAll?: boolean }) => unknown
  savedSearches: SearchEntry[]
  recentSearches: SearchEntry[]
  isCurrentSearchSaved: boolean
  saveCurrentSearch: () => void
  applySavedSearch: (entry: SearchEntry) => unknown
  deleteSavedSearch: (id: string) => void
  deleteRecentSearch: (id: string) => void
  persistRecentSearches: (next: SearchEntry[]) => void
}

/**
 * The list header while searching: the query box, its mode toggles, and the
 * saved and recent searches dropdown.
 */
export function SearchPanel({ search }: { search: SearchPanelState }) {
  const t = useT()
  const { accounts, applySavedSearch, attachmentType, deleteRecentSearch, deleteSavedSearch, handleSearch, isCurrentSearchSaved, persistRecentSearches, recentSearches, saveCurrentSearch, savedSearches, searchAll, searchInput, searchMode, setAttachmentType, setSearchAll, setSearchInput, setSearchMode, setSearchResults, setShowSavedMenu, setShowSearch, showSavedMenu } = search
  return (
    <div className="flex-1 flex flex-col gap-1.5 relative">
      <div className="flex items-center gap-2">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-ink-3 flex-shrink-0"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
        <input
          autoFocus
          type="text"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onFocus={() => setShowSavedMenu(true)}
          onBlur={() => setTimeout(() => setShowSavedMenu(false), 120)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch(searchInput); if (e.key === 'Escape') { setShowSearch(false); setSearchInput(''); setSearchResults(null); setSearchMode('email'); setAttachmentType(''); setSearchAll(false); setShowSavedMenu(false) } }}
          placeholder={searchMode === 'attachment' ? t('Attachment name…') : t('Search emails…')}
          className="flex-1 text-[13px] bg-transparent text-ink placeholder-ink-3 focus:outline-none"
        />
        <button
          onClick={() => { setSearchMode(searchMode === 'attachment' ? 'email' : 'attachment'); setAttachmentType('') }}
          title={t('Search attachments')}
          className={`px-2 py-1 text-[10px] rounded-full border transition-colors ${searchMode === 'attachment'
            ? 'text-ink bg-accent/10 border-accent/40'
            : 'text-ink-3 border-line hover:text-ink '
          }`}
        >
          {t('Attachments')}
        </button>
        <button
          onMouseDown={e => e.preventDefault()}
          onClick={saveCurrentSearch}
          disabled={!searchInput.trim() || isCurrentSearchSaved}
          title={isCurrentSearchSaved ? t('Already saved') : t('Save this search')}
          aria-label={t('Save this search')}
          className={`px-2 py-1 text-[10px] rounded-full border transition-colors disabled:opacity-40
            ${isCurrentSearchSaved
              ? 'text-accent-ink bg-accent/14 border-accent/40'
              : 'text-ink-3 border-line/60 hover:text-ink hover:bg-ink/5'
            }`}
        >
          {isCurrentSearchSaved ? t('Saved') : t('Save')}
        </button>
        <button
          onClick={() => setSearchAll(v => !v)}
          title={t('Search all accounts')}
          className={`px-2 py-1 text-[10px] rounded-full border transition-colors ${searchAll
            ? 'text-ink bg-info/10 border-info/40'
            : 'text-ink-3 border-line hover:text-ink '
          }`}
        >
          {t('All accounts')}
        </button>
        <button onClick={() => { setShowSearch(false); setSearchInput(''); setSearchResults(null); setSearchMode('email'); setAttachmentType(''); setSearchAll(false) }}
          className="text-ink-3 hover:text-danger transition-colors p-0.5 flex-shrink-0">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
      </div>
      {searchMode === 'attachment' && (
        <div className="flex items-center gap-2">
          <div className="text-[10px] text-ink-3 ">{t('Type')}</div>
          <input
            type="text"
            value={attachmentType}
            onChange={e => setAttachmentType(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSearch(searchInput) }}
            placeholder="pdf, png, image/*"
            className="flex-1 text-[10.5px] bg-transparent text-ink placeholder-ink-3 focus:outline-none"
          />
        </div>
      )}
      {showSavedMenu && (savedSearches.length > 0 || recentSearches.length > 0) && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-50 glass-elevated rounded-xl py-1.5 animate-pop max-h-80 overflow-y-auto">
          {savedSearches.length > 0 && (
            <SearchSection
              title={t('Saved')}
              entries={savedSearches}
              onApply={applySavedSearch}
              onRemove={deleteSavedSearch}
              removeTitle={t('Remove saved search')}
            />
          )}

          {recentSearches.length > 0 && (
            <SearchSection
              title={t('Recent')}
              entries={recentSearches}
              onApply={applySavedSearch}
              onRemove={deleteRecentSearch}
              removeTitle={t('Remove from recents')}
              onClearAll={() => persistRecentSearches([])}
              clearLabel={t('Clear recent searches')}
            />
          )}
        </div>
      )}
    </div>
  )
}
