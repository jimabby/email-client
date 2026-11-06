import { test, expect, type Page } from '@playwright/test'
const accounts = [{ id: 'one', type: 'imap', email: 'one@example.com', name: 'Account One' }, { id: 'two', type: 'imap', email: 'two@example.com', name: 'Account Two' }]
async function setup(page: Page) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    let body: unknown = []
    if (path.endsWith('/auth-check')) body = { authenticated: true }
    else if (path.endsWith('/auth/accounts')) body = accounts
    else if (path.endsWith('/ai/privacy')) body = { localOnly: false, automaticAccounts: [] }
    else if (path.endsWith('/ai/settings')) body = { configured: false }
    else if (path.endsWith('/screener')) body = { enabled: false, pending: [], allowed: [], blocked: [] }
    else if (path.endsWith('/unread-counts')) body = {}
    else if (path.endsWith('/daily-report')) body = null
    else if (path.endsWith('/emails/one') || path.endsWith('/emails/two')) body = { emails: [], nextToken: null }
    else if (path.endsWith('/folders')) body = [{ name: 'Inbox', path: 'INBOX' }]
    else if (path.includes('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"ready"}\n\n' })
    await route.fulfill({ json: body })
  })
  await page.goto('/')
  await page.getByLabel('Storage passphrase').fill('test-only-storage-passphrase')
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(page.getByLabel('Storage passphrase')).toHaveCount(0)
  await expect.poll(() => page.evaluate(async () => (await import('/src/store/emailStore.ts')).useEmailStore.getState().accounts.length)).toBe(2)
}
async function compose(page: Page) {
  await page.evaluate(async () => (await import('/src/store/emailStore.ts')).useEmailStore.getState().openCompose({ accountId: 'one' }))
  await page.getByPlaceholder('recipient@example.com').fill('recipient@example.com')
  await page.getByPlaceholder('Email subject').fill('Important draft')
  await page.locator('[contenteditable=true]').first().fill('Keep this message')
}
test('offline compose survives reload encrypted and flushes with the same request id', async ({ page }) => {
  await setup(page); await compose(page)
  let requestId = ''
  await page.route('**/api/emails/one/send', route => { requestId = route.request().postDataJSON().requestId; return route.abort() })
  await page.getByLabel('Send email', { exact: true }).click()
  await expect(page.getByPlaceholder('Email subject')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('hermes-local-outbox'))).toBeNull()
  await page.reload(); await page.getByLabel('Storage passphrase').fill('test-only-storage-passphrase'); await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await import('/src/lib/localOutbox.ts')).count())).toBe(1)
  await page.route('**/api/emails/one/send', async route => { expect(route.request().postDataJSON().requestId).toBe(requestId); await route.fulfill({ json: { jobId: 'accepted', queued: true } }) })
  await page.evaluate(async () => (await import('/src/lib/localOutbox.ts')).flush())
  expect(await page.evaluate(async () => (await import('/src/lib/localOutbox.ts')).count())).toBe(0)
})
test('storage failure preserves composer and does not claim offline success', async ({ page }) => {
  await setup(page); await compose(page)
  await page.route('**/api/emails/one/send', route => route.abort())
  await page.evaluate(() => { IDBObjectStore.prototype.put = () => { throw new DOMException('Disk full', 'QuotaExceededError') } })
  await page.getByLabel('Send email', { exact: true }).click()
  await expect(page.getByPlaceholder('Email subject')).toHaveValue('Important draft')
  await expect(page.getByText('Disk full', { exact: true })).toBeVisible()
})
test('undo send cancels the accepted job', async ({ page }) => {
  await setup(page); await compose(page)
  await page.route('**/api/emails/one/send', route => route.fulfill({ json: { jobId: 'undo-job', queued: true, canUndoUntil: new Date(Date.now() + 60000).toISOString() } }))
  let cancelled = false
  await page.route('**/send-queue/undo-job/cancel', route => { cancelled = true; return route.fulfill({ json: { success: true } }) })
  await page.getByLabel('Send email', { exact: true }).click()
  await page.getByRole('button', { name: /Undo/, exact: false }).last().click()
  await expect.poll(() => cancelled).toBe(true)
})
test('switching accounts composes from the selected account', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => { const s = (await import('/src/store/emailStore.ts')).useEmailStore.getState(); s.setCurrentAccount('two'); s.openCompose() })
  await expect(page.locator('select').filter({ has: page.locator('option[value="two"]') }).first()).toHaveValue('two')
})
test('permanently rejected offline messages remain visible without background retries', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => (await import('/src/lib/localOutbox.ts')).enqueue('one', { requestId: 'reject-test-123', to: 'invalid', subject: 'Fix me' }, new Error('offline')))
  let calls = 0
  await page.route('**/api/emails/one/send', route => { calls++; return route.fulfill({ status: 400, json: { error: 'Invalid recipient' } }) })
  await page.evaluate(async () => { const q = await import('/src/lib/localOutbox.ts'); await q.flush(); await q.flush() })
  expect(calls).toBe(1)
  expect(await page.evaluate(async () => (await import('/src/lib/localOutbox.ts')).list()[0].rejected)).toBe(true)
})


test('writing autosaves encrypted draft before closing or sending', async ({ page }) => {
  await setup(page); await compose(page)
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved locally' })).toBeVisible()
  await page.reload(); await page.getByLabel('Storage passphrase').fill('test-only-storage-passphrase'); await page.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await import('/src/store/emailStore.ts')).useEmailStore.getState().drafts.some(d => d.subject === 'Important draft' && d.body.includes('Keep this message')))).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem('hermes-drafts'))).toBeNull()
})

test('missing attachment warning can cancel delivery', async ({ page }) => {
  await setup(page); await compose(page)
  await page.locator('[contenteditable=true]').first().fill('Please see the attached file')
  let calls = 0; await page.route('**/api/emails/one/send', route => { calls++; return route.fulfill({ json: { queued: true, jobId: 'job' } }) })
  await page.getByLabel('Send email', { exact: true }).click()
  await expect(page.getByText('Your message mentions an attachment, but no files are attached.')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(calls).toBe(0)
  await expect(page.getByPlaceholder('Email subject')).toHaveValue('Important draft')
})

const message = { id: 'one::INBOX::7', accountId: 'one', folder: 'INBOX', from: 'Friend <friend@example.org>', to: 'one@example.com', subject: 'Plans', snippet: '', date: new Date().toISOString(), read: true, starred: false }
async function openMessage(page: Page, body: Record<string, unknown>) {
  await page.route('**/api/emails/one/message/**', route => route.fulfill({ json: { from: message.from, to: message.to, subject: message.subject, date: message.date, text: 'Meet at noon.', html: '', attachments: [], ...body } }))
  // The list loads a body when a row is clicked; here the body is handed to
  // the store directly, the way that click would.
  const full = { from: message.from, to: message.to, subject: message.subject, date: message.date, text: 'Meet at noon.', html: '', attachments: [], ...body }
  await page.evaluate(async ([m, b]) => {
    const s = (await import('/src/store/emailStore.ts')).useEmailStore.getState()
    s.setEmails([m as any]); s.setSelectedEmail(m as any); s.setSelectedEmailBody(b as any)
  }, [message, full] as const)
}

test('encrypt toggle appears with a key and sends the request as OpenPGP', async ({ page }) => {
  await setup(page)
  await page.route('**/api/pgp/readiness', route => route.fulfill({ json: { canSign: true, canEncrypt: true, missing: [] } }))
  await compose(page)
  let payload: any = null
  await page.route('**/api/emails/one/send', route => { payload = route.request().postDataJSON(); return route.fulfill({ json: { queued: true, jobId: 'job' } }) })
  await page.getByRole('switch', { name: 'Encrypt' }).click()
  await expect(page.getByRole('switch', { name: 'Encrypt' })).toHaveAttribute('aria-checked', 'true')
  await page.getByLabel('Send email', { exact: true }).click()
  await expect.poll(() => payload?.pgp).toEqual({ encrypt: true, sign: true })
})

test('encrypt stays off while a recipient has no key', async ({ page }) => {
  await setup(page)
  await page.route('**/api/pgp/readiness', route => route.fulfill({ json: { canSign: true, canEncrypt: false, missing: ['recipient@example.com'] } }))
  await compose(page)
  await expect(page.getByRole('switch', { name: 'Encrypt' })).toBeDisabled()
  await expect(page.getByRole('switch', { name: 'Encrypt' })).toHaveAttribute('title', /recipient@example\.com/)
})

test('the reader shows what OpenPGP made of a message', async ({ page }) => {
  await setup(page)
  await openMessage(page, { pgp: { encrypted: true, decrypted: true, signed: true, status: 'verified', signer: 'friend@example.org', fingerprint: 'ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234' } })
  await expect(page.getByText('Encrypted · Signed')).toBeVisible()
  await expect(page.getByText('Meet at noon.')).toBeVisible()
})

test('a signature from the wrong key is flagged in the reader', async ({ page }) => {
  await setup(page)
  await openMessage(page, { pgp: { encrypted: false, signed: true, status: 'mismatch', signer: 'impostor@evil.example' } })
  await expect(page.getByRole('alert').filter({ hasText: 'impostor@evil.example' })).toBeVisible()
})

test('"Not a newsletter" sends a digest sender back to the inbox', async ({ page }) => {
  await setup(page)
  const digest = {
    settings: { enabled: true, folder: 'Digest', deliverAt: '17:00', autoDetect: true, senders: [], excluded: [] },
    state: { lastDeliveredAt: null, lastDeliveredDate: null, collected: {}, lastCount: 0 },
    groups: [{ sender: 'news@acme.example', name: 'Acme', count: 1, unread: 1, latest: new Date().toISOString(), emails: [{ ...message, id: 'one::Digest::1', folder: 'Digest', digestFolder: 'Digest', from: 'Acme <news@acme.example>', subject: 'October news', read: false, isNew: true }] }],
    errors: [],
  }
  await page.route('**/api/emails/digest', route => route.fulfill({ json: digest }))
  let released = ''
  await page.route('**/api/emails/digest/release', route => { released = route.request().postDataJSON().sender; return route.fulfill({ json: { sender: released, moved: 1, failures: [] } }) })
  await page.evaluate(async () => (await import('/src/store/emailStore.ts')).useEmailStore.getState().setShowDigestModal(true))
  await expect(page.getByText('October news')).toBeVisible()
  await page.getByRole('button', { name: 'Not a newsletter' }).click()
  await expect.poll(() => released).toBe('news@acme.example')
})

test('a sender can be sorted into a tab for good', async ({ page }) => {
  await setup(page)
  await openMessage(page, {})
  let saved: any = null
  await page.route('**/api/emails/category-overrides', route => { saved = route.request().postDataJSON(); return route.fulfill({ json: { key: 'friend@example.org', scope: 'sender', category: saved.category } }) })
  await page.getByLabel('More actions').click()
  await page.getByRole('menuitem', { name: 'Always sort this sender into…' }).click()
  await page.getByRole('radio', { name: 'Jobs' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => saved).toEqual({ from: message.from, scope: 'sender', category: 'Jobs' })
  await expect.poll(() => page.evaluate(async () => (await import('/src/store/emailStore.ts')).useEmailStore.getState().emailCategories['one::INBOX::7'])).toBe('Jobs')
})

test('a message encrypted to a locked key can be unlocked from the reader', async ({ page }) => {
  await setup(page)
  let unlocked = ''
  await page.route('**/api/pgp/unlock', route => { unlocked = route.request().postDataJSON().passphrase; return route.fulfill({ json: { unlocked: [{ email: 'one@example.com', unlockedUntil: new Date(Date.now() + 3600000).toISOString() }] } }) })
  await openMessage(page, { text: '', pgp: { encrypted: true, decrypted: false, locked: true, error: 'Your OpenPGP key is locked. Unlock it with its passphrase to read this message.' } })
  // After unlocking, the reader asks for the message again and gets it open.
  await page.route('**/api/emails/one/message/**', route => route.fulfill({ json: { from: message.from, to: message.to, subject: 'Plans', date: message.date, text: 'Now readable.', html: '', attachments: [], pgp: { encrypted: true, decrypted: true } } }))
  await page.getByRole('alert').getByRole('button', { name: 'Unlock' }).click()
  await page.getByRole('dialog').locator('input[type=password]').fill('correct horse battery')
  await page.getByRole('dialog').getByRole('button', { name: 'Unlock' }).click()
  await expect.poll(() => unlocked).toBe('correct horse battery')
  await expect(page.getByText('Now readable.')).toBeVisible()
})
