import { useT } from '../../lib/i18n'

export interface PgpReadiness { canSign: boolean; canEncrypt: boolean; missing: string[]; locked?: boolean }

/**
 * The composer's per-message options beside Send: the undo window, a
 * "remind me if nobody replies" follow-up, and, once the sending address has
 * an OpenPGP key, Encrypt and Sign.
 */
export function SendOptions({
  undoWindowSec, onUndoWindowSec, followUpDays, onFollowUpDays,
  pgpReady, pgpEncrypt, pgpSign, onTogglePgp,
}: {
  undoWindowSec: number
  onUndoWindowSec: (seconds: number) => void
  followUpDays: number
  onFollowUpDays: (days: number) => void
  pgpReady: PgpReadiness | null
  pgpEncrypt: boolean
  pgpSign: boolean
  onTogglePgp: (which: 'encrypt' | 'sign') => void
}) {
  const t = useT()
  return (
    <>
      <select
        value={undoWindowSec}
        onChange={e => onUndoWindowSec(parseInt(e.target.value, 10))}
        title={t('Undo send window')}
        className="field text-[12px] px-2 py-1.5 !rounded-xl text-ink-2"
      >
        <option value={0}>{t('Undo off')}</option>
        <option value={60}>{t('Undo 1 min')}</option>
        <option value={120}>{t('Undo 2 min')}</option>
      </select>
      <select
        value={followUpDays}
        onChange={e => onFollowUpDays(Number(e.target.value))}
        title={t('Remind me if nobody replies')}
        aria-label={t('Remind me if nobody replies')}
        className={`field text-[12px] px-2 py-1.5 !rounded-xl ${followUpDays ? 'text-accent-ink' : 'text-ink-2'}`}
      >
        <option value={0}>{t('No follow-up')}</option>
        <option value={1}>{t('Remind if no reply in 1 day')}</option>
        <option value={3}>{t('Remind if no reply in 3 days')}</option>
        <option value={7}>{t('Remind if no reply in 1 week')}</option>
        <option value={14}>{t('Remind if no reply in 2 weeks')}</option>
      </select>
      {pgpReady?.canSign && (
        <>
          <button
            type="button"
            role="switch"
            aria-checked={pgpEncrypt}
            disabled={!pgpReady.canEncrypt}
            onClick={() => onTogglePgp('encrypt')}
            title={pgpReady.canEncrypt
              ? t('Encrypt: only the recipients can read the subject, body, and attachments. Sender and recipients stay visible.')
              : pgpReady.missing.length
                ? t('No encryption key for {emails}', { emails: pgpReady.missing.join(', ') })
                : t('Add a recipient to encrypt')}
            className={`field text-[12px] px-2.5 py-1.5 !rounded-xl inline-flex items-center gap-1 disabled:opacity-40 ${pgpEncrypt ? 'text-success !border-success/40' : 'text-ink-2'}`}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="2" y="5.5" width="8" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M4 5.5V4a2 2 0 014 0v1.5" stroke="currentColor" strokeWidth="1.2"/></svg>
            {t('Encrypt')}
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={pgpSign || pgpEncrypt}
            disabled={pgpEncrypt}
            onClick={() => onTogglePgp('sign')}
            title={pgpEncrypt ? t('Encrypted mail is always signed') : t('Sign: recipients with your key can verify it came from you, unchanged.')}
            className={`field text-[12px] px-2.5 py-1.5 !rounded-xl ${pgpSign || pgpEncrypt ? 'text-success !border-success/40' : 'text-ink-2'}`}
          >
            {t('Sign')}
          </button>
        </>
      )}
    </>
  )
}
