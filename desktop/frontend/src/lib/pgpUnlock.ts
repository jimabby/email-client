import { pgpApi } from '../api/client'
import { promptDialog } from '../components/DialogHost'
import { t } from './i18n'
import { useEmailStore } from '../store/emailStore'

/**
 * Ask for the OpenPGP passphrase and unlock every locked key it opens.
 * @returns true when at least one key was unlocked.
 */
export async function promptUnlockPgp(email?: string): Promise<boolean> {
  const passphrase = await promptDialog({
    title: t('Unlock your encryption key'),
    label: email
      ? t('Enter the passphrase for {email}. It stays unlocked on this backend for 8 hours, or until it restarts.', { email })
      : t('Enter your key passphrase. It stays unlocked on this backend for 8 hours, or until it restarts.'),
    secret: true,
    confirmLabel: t('Unlock'),
  })
  if (!passphrase) return false
  try {
    await pgpApi.unlock(passphrase, email)
    useEmailStore.getState().showNotification('success', t('Key unlocked'))
    return true
  } catch (err) {
    const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
    useEmailStore.getState().showNotification('error', message || t('That passphrase does not unlock this key'))
    return false
  }
}
