import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { emailsApi } from '../api/client'
import { useEmailStore } from '../store/emailStore'
import type { CalendarInvite, EmailSummary } from '../types/email'

interface Props {
  invite: CalendarInvite
  email: EmailSummary
}

type Choice = 'accepted' | 'declined' | 'tentative'

const CHOICES: Array<{ value: Choice; label: string }> = [
  { value: 'accepted', label: 'Accept' },
  { value: 'tentative', label: 'Maybe' },
  { value: 'declined', label: 'Decline' },
]

/** "Tue 1 Sep, 09:30 – 10:30" or "Tue 1 Sep (all day)". */
function formatWhen(invite: CalendarInvite): string {
  const { start, end } = invite
  if (!start) return 'Time not specified'

  try {
    if (start.allDay) {
      return `${format(parseISO(start.iso), 'EEE d MMM')} · All day`
    }
    const startAt = parseISO(start.iso)
    const day = format(startAt, 'EEE d MMM')
    const from = format(startAt, 'HH:mm')
    const to = end ? format(parseISO(end.iso), 'HH:mm') : null
    const range = to ? `${from} – ${to}` : from
    // A floating time has no zone information, so say so rather than implying
    // it has been converted to the reader's own.
    return `${day} · ${range}${start.floating ? ` (${start.tzid || 'local time'})` : ''}`
  } catch {
    return start.iso
  }
}

const STATUS_LABEL: Record<string, string> = {
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  TENTATIVE: 'Maybe',
  'NEEDS-ACTION': 'No reply yet',
}

export function InviteCard({ invite, email }: Props) {
  const showNotification = useEmailStore(s => s.showNotification)
  const [sending, setSending] = useState<Choice | null>(null)
  const [answered, setAnswered] = useState<Choice | null>(null)

  const respond = async (choice: Choice) => {
    setSending(choice)
    try {
      await emailsApi.rsvp(email.accountId, email.id, choice, email.folder)
      setAnswered(choice)
      showNotification('success', `${CHOICES.find(c => c.value === choice)!.label}ed — reply sent to the organiser`)
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Could not send your reply')
    } finally {
      setSending(null)
    }
  }

  const cancelled = invite.status === 'CANCELLED'
  const attendees = invite.attendees || []

  return (
    <div className="mt-4 rounded-xl border border-line bg-surface-2 overflow-hidden">
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="mt-0.5 shrink-0 text-accent" aria-hidden="true">
          <rect x="2.5" y="3.5" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2.5 7h13M6 2.5v2M12 2.5v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-3">
            {cancelled ? 'Cancelled meeting' : invite.method === 'REPLY' ? 'Invitation reply' : 'Meeting invitation'}
          </div>
          <div className={`text-[15px] font-semibold text-ink mt-1 ${cancelled ? 'line-through' : ''}`}>
            {invite.summary || '(no title)'}
          </div>
          <div className="text-[12.5px] text-ink-2 mt-1">{formatWhen(invite)}</div>
          {invite.recurrence && (
            <div className="text-[12px] text-ink-3 mt-0.5">{invite.recurrence.text}</div>
          )}
          {invite.location && (
            <div className="text-[12.5px] text-ink-2 mt-1.5 break-words">{invite.location}</div>
          )}
          {invite.organizer?.email && (
            <div className="text-[12px] text-ink-3 mt-1.5">
              Organised by {invite.organizer.name || invite.organizer.email}
            </div>
          )}
        </div>
      </div>

      {attendees.length > 0 && (
        <details className="border-t border-line/60 px-4 py-2.5">
          <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink-2 transition-colors">
            {attendees.length} guest{attendees.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 space-y-1">
            {attendees.slice(0, 30).map(a => (
              <li key={a.email} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                <span className="text-ink-2 truncate">
                  {a.name || a.email}
                  {a.optional && <span className="text-ink-3"> · optional</span>}
                </span>
                <span className="text-ink-3 shrink-0">{STATUS_LABEL[a.status] || a.status}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {!cancelled && invite.method === 'REQUEST' && (
        <div className="flex items-center gap-2 border-t border-line/60 px-4 py-3">
          {CHOICES.map(choice => {
            const isAnswer = answered === choice.value
            return (
              <button
                key={choice.value}
                onClick={() => respond(choice.value)}
                disabled={sending !== null}
                className={`rounded-lg px-3.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50 ${
                  isAnswer
                    ? 'bg-accent text-accent-ink'
                    : 'border border-line text-ink-2 hover:bg-ink/6'
                }`}
              >
                {sending === choice.value ? 'Sending…' : choice.label}
              </button>
            )
          })}
          {answered && (
            <span className="text-[12px] text-ink-3 ml-1">Reply sent</span>
          )}
        </div>
      )}
    </div>
  )
}
