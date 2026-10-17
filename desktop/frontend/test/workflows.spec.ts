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
