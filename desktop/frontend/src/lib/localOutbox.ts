import axios from 'axios'
import { emailsApi } from '../api/client'
import { readPrivate, updatePrivate } from './privateStorage'

/**
 * A send queue that lives in the browser, in front of the server's.
 *
 * The backend outbox is what survives a flaky *provider* — it retries a send
 * that SMTP rejected with a 4xx, backs off, and keeps trying. But it can only
 * do that for a message that reached it. If the backend itself is unreachable
 * (the utilityProcess crashed and is restarting, the laptop is on a train, the
 * VPS is rebooting) the POST fails in the renderer and the composed message was
 * simply gone: the composer closed, or the user was handed an error and left to
 * copy their text out by hand.
 *
 * So a send that never reached the server is parked here and retried. This is
 * deliberately *not* the server outbox — nothing here has been accepted by
 * anything yet, and the two must not be conflated in the UI.
 */

const KEY = 'hermes-local-outbox'

export type SendPayload = Parameters<typeof emailsApi.send>[1]

export interface LocalOutboxItem {
  id: string
  accountId: string
  payload: SendPayload
  /** For the UI, so a listing does not have to open the payload. */
  subject: string
  to: string
  queuedAt: string
  attempts: number
  rejected?: boolean
  lastError: string | null
}

type Listener = (items: LocalOutboxItem[]) => void
const listeners = new Set<Listener>()

function read(): LocalOutboxItem[] {
  const items = readPrivate<LocalOutboxItem[]>(KEY, [])
  return Array.isArray(items) ? items : []
}

async function update(change: (items: LocalOutboxItem[]) => LocalOutboxItem[]) {
  const stored = await updatePrivate<LocalOutboxItem[]>(KEY, change)
  for (const listener of listeners) listener(stored)
  return stored
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  listener(read())
  return () => { listeners.delete(listener) }
}

export function list(): LocalOutboxItem[] {
  return read()
}

export function count(): number {
  return read().length
}

/**
 * Is retrying this idempotent request appropriate?
 *
 * A 4xx is the server having an opinion — a malformed address, an alias the
 * account does not own — and retrying that forever would be a spin. Only a
 * transport failure or a server-side error is held with the same request id.
 */
export function isUnreachable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false
  if (!err.response) return true // no response at all: DNS, refused, timeout, offline
  return err.response.status >= 500
}

export async function enqueue(accountId: string, payload: SendPayload, error: unknown): Promise<LocalOutboxItem> {
  const item: LocalOutboxItem = {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    accountId,
    payload: { ...payload, requestId: payload.requestId || crypto.randomUUID() },
    subject: payload.subject || '(no subject)',
    to: payload.to || '',
    queuedAt: new Date().toISOString(),
    attempts: 1,
    lastError: error instanceof Error ? error.message : 'Could not reach the Hermes service',
  }
  await update(items => [...items.filter(existing => existing.accountId !== accountId || existing.payload.requestId !== item.payload.requestId), item])
  return item
}

export async function remove(id: string) {
  await update(items => items.filter(item => item.id !== id))
}

let flushing = false

/**
 * Try to hand every parked message to the server.
 *
 * Runs one at a time and in order. Permanently rejected items stay visible
 * with their reason and wait for an explicit retry — it will never succeed, and leaving it in place
 * would block everything behind it.
 *
 * @returns the number of messages that made it through.
 */
export async function flush(includeRejected = false): Promise<number> {
  if (flushing) return 0
  flushing = true
  let sent = 0

  try {
    // Persist IDs for migrated messages before making a request.
    await update(items => items.map(item => item.payload.requestId ? item : { ...item, payload: { ...item.payload, requestId: crypto.randomUUID() } }))
    for (const item of read()) {
      if (item.rejected && !includeRejected) continue
      try {
        await emailsApi.send(item.accountId, item.payload)
        sent++
      } catch (err) {
        if (isUnreachable(err)) break // still down; leave the rest for later
        // Preserve the message, but pause automatic retries after a rejection.
        await update(items => items.map(existing => existing.id === item.id
          ? {
              ...existing,
              attempts: existing.attempts + 1,
              lastError: err instanceof Error ? err.message : 'The server rejected this message',
              rejected: true,
            } as LocalOutboxItem
          : existing))
        continue
      }
      // A storage error after acceptance must not be reported as a server rejection.
      // Keeping the same request ID makes a later cleanup retry safe.
      await remove(item.id)
    }
  } finally {
    flushing = false
  }

  return sent
}

/**
 * Retry whenever the machine looks like it came back, and on a slow timer as a
 * backstop — `online` does not fire when it was the backend, not the network,
 * that was down.
 */
export function startFlushLoop(onSent?: (count: number) => void): () => void {
  const run = () => {
    if (!read().length) return
    flush().then(sent => { if (sent && onSent) onSent(sent) }).catch(() => {})
  }

  run()
  const timer = window.setInterval(run, 30_000)
  window.addEventListener('online', run)

  return () => {
    window.clearInterval(timer)
    window.removeEventListener('online', run)
  }
}
