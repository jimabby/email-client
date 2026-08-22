import { useEmailStore } from '../store/emailStore'
import { EMAIL_CATEGORIES } from '../types/email'
import type { EmailCategory } from '../types/email'

export function CategoryTabs() {
  const { emails, emailCategories, activeCategory, setActiveCategory, currentAccountId, getUnreadCount: serverUnread } = useEmailStore()

  function getUnreadCount(cat: EmailCategory) {
    // Categories only exist client-side, so per-category counts still come from
    // the loaded page. "All" can use the provider's real inbox total.
    if (cat === 'All') {
      const total = currentAccountId ? serverUnread(currentAccountId, 'INBOX') : 0
      return total || emails.filter(e => !e.read).length
    }
    return emails.filter(e => !e.read && emailCategories[e.id] === cat).length
  }

  return (
    // A segmented control rather than underlined tabs: the selected pill reads
    // at a glance in a pane this narrow, and it keeps the list's soft geometry.
    <div className="flex gap-0.5 p-1.5 pb-1 mx-1 rounded-xl" role="tablist" aria-label="Inbox categories">
      {EMAIL_CATEGORIES.map(cat => {
        const unread = getUnreadCount(cat)
        const isActive = activeCategory === cat
        return (
          <button
            key={cat}
            role="tab"
            aria-selected={isActive}
            onClick={() => setActiveCategory(cat)}
            className={`flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[11.5px] whitespace-nowrap
                        flex-1 min-w-0 transition-all duration-200
              ${isActive
                ? 'bg-accent/16 text-accent-ink font-semibold shadow-[inset_0_0_0_1px_rgb(var(--accent)/0.22)]'
                : 'text-ink-2 hover:text-ink hover:bg-ink/5'
              }`}
          >
            <span className="truncate">{cat}</span>
            {unread > 0 && (
              <span className={`px-1 rounded-full text-[10px] font-semibold leading-[1.5] tabular-nums flex-shrink-0
                ${isActive ? 'bg-accent text-[#201500]' : 'bg-ink/12 text-ink-2'}`}>
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
