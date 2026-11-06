import { emailsApi } from '../../api/client'
import { useEmailStore } from '../../store/emailStore'
import { useT } from '../../lib/i18n'
import { promptUnlockPgp } from '../../lib/pgpUnlock'
import type { EmailSummary, PgpStatus } from '../../types/email'

/**
 * Warnings above an OpenPGP message's body: it could not be opened (with an
 * Unlock button when the key is only locked), its signature should not be
 * trusted, or the sender's advertised key has changed.
 */
export function PgpNotices({ email, pgp }: { email: EmailSummary; pgp: PgpStatus }) {
  const t = useT()
  const showNotification = useEmailStore(s => s.showNotification)
  return (
    <>
    {pgp.encrypted && !pgp.decrypted && (
      <div role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/8 px-4 py-3 text-[12.5px] text-danger flex items-center gap-3">
        <span className="flex-1">{pgp.error || t('This message is encrypted, and none of your keys can open it.')}</span>
        {pgp.locked && (
          <button
            onClick={async () => {
              if (!(await promptUnlockPgp())) return
              // Open it again now that the key can be used.
                            try {
                const fresh = await emailsApi.getBody(email.accountId, email.id, email.folder)
                if (useEmailStore.getState().selectedEmail?.id === email.id) useEmailStore.getState().setSelectedEmailBody(fresh)
              } catch { showNotification('error', t('Could not reload this message')) }
            }}
            className="btn-accent text-[11.5px] font-semibold px-3 py-1.5 rounded-lg flex-shrink-0"
          >
            {t('Unlock')}
          </button>
        )}
      </div>
    )}
    {(pgp.status === 'bad' || pgp.status === 'mismatch') && (
      <div role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/8 px-4 py-3 text-[12.5px] text-danger">
        {pgp.status === 'bad'
          ? t('The signature on this message does not match its content. It may have been altered.')
          : t('This message is signed with a key that belongs to {signer}, not the sender. Treat it with suspicion.', { signer: pgp.signer || t('someone else') })}
      </div>
    )}
    {pgp.learned?.changed && (
      <div role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/8 px-4 py-3 text-[12.5px] text-danger">
        {t('{sender} is now advertising a different encryption key. Hermes kept the one you had. Confirm with them before trusting the new key.', { sender: pgp.learned.changed })}
      </div>
    )}
    </>
  )
}
