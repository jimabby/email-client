import DOMPurify from 'dompurify'
import { useEmailStore } from '../store/emailStore'

export function DailyReportModal() {
  const { pendingReport, clearPendingReport } = useEmailStore()

  if (!pendingReport) return null

  const clean = DOMPurify.sanitize(pendingReport.html)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={clearPendingReport} />
      <div className="relative glass-elevated rounded-3xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden animate-rise">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line ">
          <div>
            <h2 className="font-semibold text-ink text-sm">Daily Report</h2>
            <p className="text-[11px] text-ink-2 mt-0.5">{pendingReport.subject}</p>
          </div>
          <button
            onClick={clearPendingReport}
            className="btn-ghost w-8 h-8 flex items-center justify-center text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div
          className="flex-1 overflow-y-auto px-5 py-4 prose prose-sm max-w-none text-ink "
          dangerouslySetInnerHTML={{ __html: clean }}
        />

        {/* Footer */}
        <div className="px-5 py-3 border-t border-line flex justify-end">
          <button
            onClick={clearPendingReport}
            className="btn-accent px-4 py-2 text-[13px] font-semibold rounded-xl"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
