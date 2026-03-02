import { useEmailStore } from '../store/emailStore'
import { EMAIL_CATEGORIES } from '../types/email'
import type { EmailCategory } from '../types/email'

export function CategoryTabs() {
  const { emails, emailCategories, activeCategory, setActiveCategory } = useEmailStore()

  function getUnreadCount(cat: EmailCategory) {
    if (cat === 'All') return emails.filter(e => !e.read).length
    return emails.filter(e => !e.read && emailCategories[e.id] === cat).length
  }

  return (
    <div className="flex border-b border-[#d0d7de] dark:border-[#30363d] bg-white dark:bg-[#0d1117]">
      {EMAIL_CATEGORIES.map(cat => {
        const unread = getUnreadCount(cat)
        const isActive = activeCategory === cat
        return (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`flex items-center gap-1 px-2 py-2 text-[10px] font-medium whitespace-nowrap border-b-2 transition-colors flex-1 justify-center
              ${isActive
                ? 'border-[#f59e0b] text-[#f59e0b]'
                : 'border-transparent text-[#656d76] dark:text-[#8b949e] hover:text-[#1f2328] dark:hover:text-[#e6edf3] hover:border-[#d0d7de] dark:hover:border-[#30363d]'
              }`}
          >
            <span>{cat}</span>
            {unread > 0 && (
              <span className={`px-1 py-0.5 rounded-full text-[9px] font-bold leading-none
                ${isActive
                  ? 'bg-[#f59e0b] text-white'
                  : 'bg-[#eaeef2] dark:bg-[#21262d] text-[#656d76] dark:text-[#8b949e]'
                }`}>
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
