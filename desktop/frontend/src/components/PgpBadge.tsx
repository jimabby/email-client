import { useT } from '../lib/i18n'
import type { PgpStatus } from '../types/email'
import { formatFingerprint } from './EncryptionSettings'

/**
 * What OpenPGP made of this message, beside the sender's name. Only a good
 * signature from a key that names the sender earns the green check; a good
 * signature from somebody else's key is a warning, not reassurance.
 */
export function PgpBadge({ pgp }: { pgp?: PgpStatus | null }) {
  const t = useT()
  if (!pgp || (!pgp.encrypted && !pgp.signed)) return null

  const lock = pgp.encrypted && pgp.decrypted
  let tone = 'text-ink-2 bg-ink/6'
  let label = ''
  let detail = ''
  if (pgp.encrypted && !pgp.decrypted) {
    tone = 'text-danger bg-danger/10'
    label = t('Encrypted')
    detail = pgp.error || t('This message is encrypted, and none of your keys can open it.')
  } else if (pgp.signed && pgp.status === 'verified') {
    tone = 'text-success bg-success/12'
    label = lock ? t('Encrypted · Signed') : t('Signed')
    detail = t('Signed by {signer}. Key fingerprint: {fingerprint}', { signer: pgp.signer || '', fingerprint: formatFingerprint(pgp.fingerprint || '') })
  } else if (pgp.signed && pgp.status === 'mismatch') {
    tone = 'text-danger bg-danger/10'
    label = t('Signature mismatch')
    detail = t('The signature is valid, but the key belongs to {signer}, not the sender.', { signer: pgp.signer || t('someone else') })
  } else if (pgp.signed && pgp.status === 'bad') {
    tone = 'text-danger bg-danger/10'
    label = t('Bad signature')
    detail = t('This message was changed after it was signed, or the signature is broken.')
  } else if (pgp.signed && pgp.status === 'unknown-key') {
    label = lock ? t('Encrypted · Unverified signature') : t('Unverified signature')
    detail = t('Signed with a key you have not imported ({keyId}). Import the sender’s key to verify it.', { keyId: pgp.keyId || '' })
  } else if (lock) {
    label = t('Encrypted')
    detail = t('Encrypted to you, but not signed: the content is private, the sender is not proven.')
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10.5px] font-semibold flex-shrink-0 ${tone}`}
      title={detail}
      aria-label={`${label}. ${detail}`}
    >
      {pgp.encrypted ? (
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="2" y="5.5" width="8" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.2"/><path d="M4 5.5V4a2 2 0 014 0v1.5" stroke="currentColor" strokeWidth="1.2"/></svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.5l2.2 2.2L9.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
      )}
      {label}
    </span>
  )
}
