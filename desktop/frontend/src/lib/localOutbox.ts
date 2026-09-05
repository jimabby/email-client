import axios from 'axios'
import { emailsApi } from '../api/client'
import { readJson, writeListWithinQuota } from './storage'

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
  lastError: string | null
}

type Listener = (items: LocalOutboxItem[]) => void
const listeners = new Set<Listener>()

function read(): LocalOutboxItem[] {
  const items = readJson<LocalOutboxItem[]>(KEY, [])
  return Array.isArray(items) ? items : []
}

function write(items: LocalOutboxItem[]) {
  // Attachments are base64 in the payload, so a queue of two large messages can
  // exceed the origin quota. Oldest-first is the wrong thing to drop, but the
  // alternative is an exception that takes the composer down mid-send.
  const { stored } = writeListWithinQuota(KEY, items)
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
 * Did this failure mean "the server never saw it"?
 *
 * A 4xx is the server having an opinion — a malformed address, an alias the
 * account does not own — and retrying that forever would be a spin. Only a
 * transport failure or a server-side error is worth holding onto.
 */
export function isUnreachable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false
  if (!err.response) return true // no response at all: DNS, refused, timeout, offline
  return err.response.status >= 500
}

export function enqueue(accountId: string, payload: SendPayload, error: unknown): LocalOutboxItem {
  const item: LocalOutboxItem = {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    accountId,
    payload,
    subject: payload.subject || '(no subject)',
    to: payload.to || '',
    queuedAt: new Date().toISOString(),
    attempts: 1,
    lastError: error instanceof Error ? error.message : 'Could not reach the Hermes service',
  }
  write([...read(), item])
  return item
}

export function remove(id: string) {
  write(read().filter(item => item.id !== id))
}

let flushing = false

/**
 * Try to hand every parked message to the server.
 *
 * Runs one at a time and in order, so a queue of replies arrives in the order
 * it was written. An item that the server *rejects* is dropped from the queue
 * with its reason recorded — it will never succeed, and leaving it in place
 * would block everything behind it.
 *
 * @returns the number of messages that made it through.
 */
export async function flush(): Promise<number> {
  if (flushing) return 0
  flushing = true
  let sent = 0

  try {
    for (const item of read()) {
      try {
        await emailsApi.send(item.accountId, item.payload)
        remove(item.id)
        sent++
      } catch (err) {
        if (isUnreachable(err)) break // still down; leave the rest for later
        // A permanent rejection. Drop it rather than retrying forever, but keep
        // the reason visible so the user is not left wondering.
        write(read().map(existing => existing.id === item.id
          ? {
              ...existing,
              attempts: existing.attempts + 1,
              lastError: err instanceof Error ? err.message : 'The server rejected this message',
              rejected: true,
            } as LocalOutboxItem
          : existing))
      }
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
