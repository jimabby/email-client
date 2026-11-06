import { useEffect, useRef, useState } from 'react'
import { aiApi, emailsApi, pgpApi } from '../../api/client'
import { useEmailStore } from '../../store/emailStore'
import { useT } from '../../lib/i18n'
import type { Attachment, EmailBody, EmailSummary } from '../../types/email'

/**
 * A message's attachments: preview, download, summarize, and "Import key" for
 * an OpenPGP public key. Rendered with `key={message id}`, so its state starts
 * fresh for each message and its object URLs are released when it unmounts.
 *
 * For a message the backend opened with OpenPGP, every request says so
 * (`pgp`), because the list came from the decrypted content rather than the
 * provider's parts.
 */
export function AttachmentList({ email, body }: { email: EmailSummary; body: EmailBody }) {
  const t = useT()
  const showNotification = useEmailStore(s => s.showNotification)
  const attachments = body.attachments || []
  const [previewOpen, setPreviewOpen] = useState<Record<number, boolean>>({})
  // Object URLs for previews, fetched with the auth header (see attachmentBlob).
  const [previewUrls, setPreviewUrls] = useState<Record<number, string | 'loading' | 'error'>>({})
  const previewUrlRef = useRef<Record<number, string>>({})
  const [attachmentSummaries, setAttachmentSummaries] = useState<Record<number, string>>({})

  useEffect(() => () => {
    for (const url of Object.values(previewUrlRef.current)) {
      try { URL.revokeObjectURL(url) } catch {}
    }
    previewUrlRef.current = {}
  }, [])

  // The server will only ever serve these types inline; everything else comes
  // back as a download, so offering a preview for it would just be a broken
  // button. Note this keys on the declared type and never on the filename —
  // an attachment called "invoice.pdf" that declares text/html is not a PDF.
  const PREVIEWABLE_TYPES = new Set([
    'application/pdf', 'text/plain',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
  ])
  const attachmentType = (att: Attachment) =>
    (att.contentType || '').toLowerCase().split(';')[0].trim()
  const isPreviewable = (att: Attachment) => PREVIEWABLE_TYPES.has(attachmentType(att))
  const isImage = (att: Attachment) => attachmentType(att).startsWith('image/')

  // A plain attachment URL in <img src> cannot carry the Authorization header,
  // so previews are fetched with it and shown from an object URL. The blob's
  // type is pinned to the allowlisted declared type, never the server's echo.
  const togglePreview = async (att: Attachment, index: number) => {
    const opening = !previewOpen[index]
    setPreviewOpen(s => ({ ...s, [index]: opening }))
    if (!opening || previewUrlRef.current[index]) return
    setPreviewUrls(s => ({ ...s, [index]: 'loading' }))
    try {
      const blob = await emailsApi.attachmentBlob(email.accountId, email.id, index, {
        folder: email.folder,
        type: attachmentType(att),
        pgp: !!body.pgp,
      })
      const url = URL.createObjectURL(blob)
      previewUrlRef.current[index] = url
      setPreviewUrls(s => ({ ...s, [index]: url }))
    } catch {
      setPreviewUrls(s => ({ ...s, [index]: 'error' }))
    }
  }

  // Downloads go through a single-use ticket URL: the browser streams the file
  // to disk itself (the server sets Content-Disposition: attachment), so a
  // large file is never held in JS memory, and the URL carries no credential.
  const downloadAttachment = async (att: Attachment, index: number) => {
    try {
      const url = await emailsApi.attachmentDownloadUrl(email.accountId, email.id, index, email.folder, !!body.pgp)
      const link = document.createElement('a')
      link.href = url
      link.download = att.filename || `attachment-${index}`
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch {
      showNotification('error', t('Could not download {name}', { name: att.filename || t('the attachment') }))
    }
  }

  // "Summarize" still needs the bytes in hand — fetch just that one file.
  const summarizeAttachment = async (att: Attachment, index: number) => {
    setAttachmentSummaries(s => ({ ...s, [index]: t('Summarizing…') }))
    try {
      const buffer = await emailsApi.fetchAttachment(email.accountId, email.id, index, email.folder, !!body.pgp)
      let binary = ''
      const bytes = new Uint8Array(buffer)
      // Chunked to stay under the argument limit of String.fromCharCode.
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      const { summary } = await aiApi.summarizeAttachment({
        filename: att.filename,
        contentType: att.contentType,
        content: btoa(binary),
      })
      setAttachmentSummaries(s => ({ ...s, [index]: summary }))
    } catch {
      setAttachmentSummaries(s => ({ ...s, [index]: t('Unable to summarize this attachment.') }))
    }
  }

  const isKeyAttachment = (att: Attachment) =>
    /application\/pgp-keys/i.test(att.contentType || '') || (/\.(asc|pub|key)$/i.test(att.filename || '') && !/^(encrypted|signature)\.asc$/i.test(att.filename || ''))

  const importKeyAttachment = async (index: number) => {
    try {
      const imported = await pgpApi.importFromAttachment(email.accountId, email.id, index, email.folder, !!body.pgp)
      showNotification('success', t('Imported a key for {emails}', { emails: imported.map(i => i.email).join(', ') }))
    } catch (err) {
      showNotification('error', (err as { response?: { data?: { error?: string } } })?.response?.data?.error || t('That attachment is not a public key'))
    }
  }

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-3 mb-2.5">{t('Attachments ({count})', { count: attachments.length })}</div>
      <div className="flex flex-wrap gap-2">
        {attachments.map((att, i) => (
          <div key={i} className="flex flex-col gap-2 w-full">
            <div className="flex items-center gap-2.5 bg-ink/4 border border-line/50 rounded-xl px-3.5 py-2.5 text-[12.5px]">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 4L6 8.5a2 2 0 01-3-2.5L8 1a3 3 0 014 4.5L5.5 11A4 4 0 01.5 5.5L6 0" stroke="#f59e0b" strokeWidth="1.2" strokeLinecap="round"/></svg>
              <span className="text-ink ">{att.filename}</span>
              <span className="text-ink-3 ">({Math.round(att.size / 1024)}KB)</span>
              {isPreviewable(att) && (
                <button
                  title={t('Preview')}
                  onClick={() => togglePreview(att, i)}
                  className="text-info hover:opacity-70 transition-opacity text-[11px]"
                >
                  {previewOpen[i] ? t('Hide') : t('Preview')}
                </button>
              )}
              <button
                title={t('Download')}
                onClick={() => downloadAttachment(att, i)}
                className="text-accent hover:text-accent-ink transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v7M3 5l3 3 3-3M1 10h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              {(attachmentType(att) === 'application/pdf' || attachmentType(att).startsWith('text/')) && (
                <button onClick={() => summarizeAttachment(att, i)} className="text-ai text-[11px]">{t('Summarize')}</button>
              )}
              {isKeyAttachment(att) && (
                <button onClick={() => importKeyAttachment(i)} className="text-info text-[11px]">{t('Import key')}</button>
              )}
            </div>
            {attachmentSummaries[i] && <div className="rounded-md bg-surface-2 p-3 text-xs whitespace-pre-wrap">{attachmentSummaries[i]}</div>}
            {previewOpen[i] && isPreviewable(att) && (
              <div className="border border-line rounded-md overflow-hidden bg-white w-full">
                {previewUrls[i] === 'loading' || !previewUrls[i] ? (
                  <div className="p-4 text-xs text-ink-3">{t('Loading preview…')}</div>
                ) : previewUrls[i] === 'error' ? (
                  <div className="p-4 text-xs text-danger">{t('Could not load this attachment.')}</div>
                ) : isImage(att) ? (
                  <img src={previewUrls[i]} alt={att.filename} className="w-full h-auto max-h-[80vh] object-contain" />
                ) : attachmentType(att) === 'application/pdf' ? (
                  // The browser's PDF viewer refuses to run inside a
                  // sandboxed frame. The blob is typed application/pdf by
                  // us (never by the sender), so it can only ever render
                  // as a PDF, which has no script access to this page.
                  <iframe title={att.filename} src={previewUrls[i]} className="w-full h-[80vh]" />
                ) : (
                  // Sandboxed: an attachment is sender-controlled content
                  // and must never run with this origin's privileges.
                  <iframe title={att.filename} src={previewUrls[i]} sandbox="" className="w-full h-[80vh]" />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
