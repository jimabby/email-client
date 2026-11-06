import { useT } from '../../lib/i18n'
import type { EmailSummary } from '../../types/email'
import { MenuItem } from './readerParts'

/**
 * The reader's "More actions" menu. Every entry closes the menu and calls
 * back into the reader, which owns the actions and their state.
 */
export function MoreMenu({ email, muted, unsubscribeLink, summaryLoading, actionsLoading, onClose, handlers }: {
  email: EmailSummary
  muted: boolean
  unsubscribeLink: string | null | undefined
  summaryLoading: boolean
  actionsLoading: boolean
  onClose: () => void
  handlers: {
    handleBlock: (...args: any[]) => unknown
    handleDigestSender: (...args: any[]) => unknown
    handleExtractActions: (...args: any[]) => unknown
    handleFollowUpLater: (...args: any[]) => unknown
    handleMarkUnread: (...args: any[]) => unknown
    handlePrint: (...args: any[]) => unknown
    handleSortSender: (...args: any[]) => unknown
    handleSpam: (...args: any[]) => unknown
    handleSummarizeThread: (...args: any[]) => unknown
    handleToggleMute: (...args: any[]) => unknown
    handleUnsubscribe: (...args: any[]) => unknown
  }
}) {
  const t = useT()
  const { handleBlock, handleDigestSender, handleExtractActions, handleFollowUpLater, handleMarkUnread, handlePrint, handleSortSender, handleSpam, handleSummarizeThread, handleToggleMute, handleUnsubscribe } = handlers
  return (
    <div role="menu" className="absolute right-0 top-full mt-1.5 w-56 glass-elevated rounded-xl z-30 py-1.5 overflow-hidden animate-pop">
      <MenuItem
        onClick={() => { onClose(); handleSummarizeThread() }}
        disabled={summaryLoading}
        label={summaryLoading ? t('Summarising…') : t('Summarise thread')}
        icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 3h10M3 7h7M3 11h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>}
      />
      <MenuItem
        onClick={() => { onClose(); handleExtractActions() }}
        disabled={actionsLoading}
        label={actionsLoading ? t('Finding…') : t('Find tasks & dates')}
        icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      />
      <MenuItem
        onClick={() => { onClose(); handlePrint() }}
        label={t('Print / save as PDF')}
        icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 6V2h8v4M4 12H2.5A1 1 0 011.5 11V7a1 1 0 011-1h11a1 1 0 011 1v4a1 1 0 01-1 1H12" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M4 9.5h8V14H4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>}
      />
      <MenuItem
        onClick={() => { onClose(); handleMarkUnread() }}
        label={t('Mark as unread')}
        icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4a1 1 0 011-1h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3"/><path d="M2 4l6 5 6-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      />
      {email.threadId && (
        <MenuItem
          onClick={() => { onClose(); handleToggleMute() }}
          label={muted ? t('Unmute conversation') : t('Mute conversation')}
          icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 6h2.5L9 3v10L5.5 10H3V6z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M11.5 6l3 4M14.5 6l-3 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>}
        />
      )}
      {/sent/i.test(email.folder || '') && (
        <MenuItem
          onClick={() => { onClose(); handleFollowUpLater(3) }}
          label={t('Remind me if no reply in 3 days')}
          icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.3"/><path d="M8 5.5v3l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>}
        />
      )}
      <MenuItem
        onClick={() => { onClose(); handleDigestSender() }}
        label={t('Send this sender to the digest')}
        icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3"/><path d="M4.5 5.5h7M4.5 8h7M4.5 10.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>}
      />
      <MenuItem
        onClick={() => { onClose(); handleSortSender() }}
        label={t('Always sort this sender into…')}
        icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5h11M2.5 8h7M2.5 11.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>}
      />
      {unsubscribeLink && (
        <MenuItem
          onClick={() => { onClose(); handleUnsubscribe(unsubscribeLink) }}
          label={t('Unsubscribe')}
          icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l5 5-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>}
        />
      )}

      <div className="my-1.5 h-px bg-line/50" role="separator" />

      <MenuItem
        onClick={() => { onClose(); handleSpam() }}
        label={t('Report spam')}
        danger
        icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/><path d="M8 5v4M8 11v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>}
      />
      <MenuItem
        onClick={() => { onClose(); handleBlock() }}
        label={t('Block sender')}
        danger
        icon={<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/><path d="M3.8 3.8l8.4 8.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>}
      />
    </div>
  )
}
