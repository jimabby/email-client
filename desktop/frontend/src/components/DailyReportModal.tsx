import DOMPurify from 'dompurify'
import { useEmailStore } from '../store/emailStore'

export function DailyReportModal() {
  const { pendingReport, clearPendingReport } = useEmailStore()

  if (!pendingReport) return null

  const clean = DOMPurify.sanitize(pendingReport.html)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={clearPendingReport} />
      <div className="relative bg-white dark:bg-[#161b22] rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col border border-[#d0d7de] dark:border-[#30363d]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#d0d7de] dark:border-[#30363d]">
          <div>
            <h2 className="font-semibold text-[#1f2328] dark:text-[#e6edf3] text-sm">Daily Report</h2>
            <p className="text-[11px] text-[#656d76] dark:text-[#8b949e] mt-0.5">{pendingReport.subject}</p>
          </div>
          <button
            onClick={clearPendingReport}
            className="w-7 h-7 flex items-center justify-center rounded-md text-[#656d76] dark:text-[#8b949e] hover:bg-[#f6f8fa] dark:hover:bg-[#21262d] transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div
          className="flex-1 overflow-y-auto px-5 py-4 prose prose-sm max-w-none dark:prose-invert text-[#1f2328] dark:text-[#e6edf3]"
          dangerouslySetInnerHTML={{ __html: clean }}
        />

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#d0d7de] dark:border-[#30363d] flex justify-end">
          <button
            onClick={clearPendingReport}
            className="px-4 py-1.5 text-xs font-medium bg-[#f59e0b] hover:bg-[#d97706] text-white rounded-md transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
