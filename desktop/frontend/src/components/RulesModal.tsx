import { useEffect, useState } from 'react'
import { useEmailStore } from '../store/emailStore'
import { emailsApi } from '../api/client'
import type { MailRule, RuleAction, RuleActionType, RuleCondition, RuleField, RuleOp } from '../types/email'

const inputCls = 'field w-full px-2.5 py-1.5 text-[12.5px]'

const FIELD_LABELS: Record<RuleField, string> = {
  from: 'From',
  to: 'To',
  subject: 'Subject',
  snippet: 'Preview text',
  hasAttachment: 'Has attachment',
}

const OP_LABELS: Record<RuleOp, string> = {
  contains: 'contains',
  notContains: 'does not contain',
  equals: 'is exactly',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matches: 'matches regex',
  isTrue: 'is true',
}

const ACTION_LABELS: Record<RuleActionType, string> = {
  markRead: 'Mark as read',
  markUnread: 'Mark as unread',
  star: 'Star',
  archive: 'Archive',
  move: 'Move to folder',
  spam: 'Report as spam',
  delete: 'Delete',
}

function newCondition(): RuleCondition {
  return { field: 'from', op: 'contains', value: '' }
}

function newRule(): MailRule {
  return {
    id: crypto.randomUUID(),
    name: 'New rule',
    enabled: true,
    match: 'all',
    conditions: [newCondition()],
    actions: [{ type: 'markRead' }],
    stopProcessing: false,
  }
}

export function RulesModal() {
  const { setShowRulesModal, showNotification, accounts, folders, emails } = useEmailStore()
  const [rules, setRules] = useState<MailRule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [previews, setPreviews] = useState<Record<string, number | 'loading'>>({})

  useEffect(() => {
    emailsApi.getRules()
      .then(setRules)
      .catch(() => showNotification('error', 'Could not load rules'))
      .finally(() => setLoading(false))
  }, [])

  const patch = (id: string, changes: Partial<MailRule>) =>
    setRules(rs => rs.map(r => (r.id === id ? { ...r, ...changes } : r)))

  const patchCondition = (ruleId: string, index: number, changes: Partial<RuleCondition>) =>
    setRules(rs => rs.map(r => r.id === ruleId
      ? { ...r, conditions: r.conditions.map((c, i) => (i === index ? { ...c, ...changes } : c)) }
      : r))

  const patchAction = (ruleId: string, index: number, changes: Partial<RuleAction>) =>
    setRules(rs => rs.map(r => r.id === ruleId
      ? { ...r, actions: r.actions.map((a, i) => (i === index ? { ...a, ...changes } : a)) }
      : r))

  const handleSave = async () => {
    setSaving(true)
    try {
      // A rule with no conditions would match nothing; drop those rather than
      // saving something that silently never fires.
      const valid = rules.filter(r => r.conditions.some(c => c.value.trim() || c.op === 'isTrue'))
      const saved = await emailsApi.saveRules(valid)
      setRules(saved)
      showNotification('success', `Saved ${saved.length} rule${saved.length === 1 ? '' : 's'}`)
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Could not save rules')
    } finally {
      setSaving(false)
    }
  }

  // Dry-run a rule against the loaded messages so the user can see what it
  // would hit before turning it on.
  const handlePreview = async (rule: MailRule) => {
    setPreviews(p => ({ ...p, [rule.id]: 'loading' }))
    try {
      const { matched } = await emailsApi.previewRule(rule, emails)
      setPreviews(p => ({ ...p, [rule.id]: matched.length }))
    } catch {
      setPreviews(p => { const next = { ...p }; delete next[rule.id]; return next })
      showNotification('error', 'Could not test this rule')
    }
  }

  // Apply the saved rules to the currently loaded messages, including ones the
  // engine already processed.
  const handleRunNow = async () => {
    try {
      const { applied } = await emailsApi.runRules(emails, true)
      showNotification('success', applied.length
        ? `Applied ${applied.length} action${applied.length === 1 ? '' : 's'}`
        : 'No messages matched')
    } catch (err) {
      showNotification('error', err instanceof Error ? err.message : 'Could not run rules')
    }
  }

  const folderOptions = (accountId?: string) => {
    const list = accountId ? folders[accountId] || [] : Object.values(folders).flat()
    const seen = new Set<string>()
    return list.filter(f => !seen.has(f.path) && seen.add(f.path))
  }

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-md z-[90] flex items-center justify-center p-4 animate-fade" onClick={() => setShowRulesModal(false)}>
      <div
        onClick={e => e.stopPropagation()}
        className="glass-elevated rounded-3xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden animate-rise"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line flex-shrink-0">
          <div>
            <h2 className="font-semibold text-sm text-ink ">Mailbox rules</h2>
            <p className="text-[11px] text-ink-3 mt-0.5">
              Rules run on the server as mail arrives — even with Hermes closed. Each message is processed once.
            </p>
          </div>
          <button onClick={() => setShowRulesModal(false)} aria-label="Close" className="text-ink-3 hover:text-ink p-1 rounded transition-colors">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {loading && <p className="text-xs text-ink-3">Loading rules…</p>}
          {!loading && !rules.length && (
            <p className="text-xs text-ink-3 py-6 text-center">
              No rules yet. Add one to file, star, or archive mail automatically.
            </p>
          )}

          {rules.map(rule => (
            <div key={rule.id} className="rounded-xl border border-line/50 bg-ink/4 p-3.5 space-y-3">
              {/* Rule header */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={e => patch(rule.id, { enabled: e.target.checked })}
                  className="accent-accent"
                  aria-label={`Enable ${rule.name}`}
                />
                <input
                  value={rule.name}
                  onChange={e => patch(rule.id, { name: e.target.value })}
                  className={`${inputCls} font-semibold flex-1`}
                  aria-label="Rule name"
                />
                <select
                  value={rule.accountId || ''}
                  onChange={e => patch(rule.id, { accountId: e.target.value || undefined })}
                  className={`${inputCls} w-40`}
                  aria-label="Apply to account"
                >
                  <option value="">All accounts</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}
                </select>
                <button
                  onClick={() => setRules(rs => rs.filter(r => r.id !== rule.id))}
                  className="text-[11px] text-danger px-2 py-1 rounded hover:bg-danger/10 "
                >
                  Delete
                </button>
              </div>

              {/* Conditions */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[11px] text-ink-2 ">
                  <span>Match</span>
                  <select
                    value={rule.match}
                    onChange={e => patch(rule.id, { match: e.target.value as 'all' | 'any' })}
                    className={`${inputCls} w-24`}
                    aria-label="Match mode"
                  >
                    <option value="all">all of</option>
                    <option value="any">any of</option>
                  </select>
                  <span>these conditions:</span>
                </div>

                {rule.conditions.map((condition, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <select
                      value={condition.field}
                      onChange={e => patchCondition(rule.id, i, { field: e.target.value as RuleField })}
                      className={`${inputCls} w-36`}
                      aria-label="Field"
                    >
                      {(Object.keys(FIELD_LABELS) as RuleField[]).map(f => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
                    </select>
                    <select
                      value={condition.op}
                      onChange={e => patchCondition(rule.id, i, { op: e.target.value as RuleOp })}
                      className={`${inputCls} w-40`}
                      aria-label="Operator"
                    >
                      {(Object.keys(OP_LABELS) as RuleOp[]).map(o => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
                    </select>
                    {condition.op !== 'isTrue' && (
                      <input
                        value={condition.value}
                        onChange={e => patchCondition(rule.id, i, { value: e.target.value })}
                        placeholder="value"
                        className={`${inputCls} flex-1`}
                        aria-label="Value"
                      />
                    )}
                    <button
                      onClick={() => patch(rule.id, { conditions: rule.conditions.filter((_, j) => j !== i) })}
                      disabled={rule.conditions.length === 1}
                      className="text-ink-3 hover:text-danger px-1.5 disabled:opacity-30"
                      aria-label="Remove condition"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => patch(rule.id, { conditions: [...rule.conditions, newCondition()] })}
                  className="text-[11px] text-info"
                >
                  + Add condition
                </button>
              </div>

              {/* Actions */}
              <div className="space-y-1.5 border-t border-line/40 pt-2.5">
                <div className="text-[11px] text-ink-2 ">Then:</div>
                {rule.actions.map((action, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <select
                      value={action.type}
                      onChange={e => patchAction(rule.id, i, { type: e.target.value as RuleActionType })}
                      className={`${inputCls} w-44`}
                      aria-label="Action"
                    >
                      {(Object.keys(ACTION_LABELS) as RuleActionType[]).map(a => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
                    </select>
                    {action.type === 'move' && (
                      <select
                        value={action.targetFolder || ''}
                        onChange={e => patchAction(rule.id, i, { targetFolder: e.target.value })}
                        className={`${inputCls} flex-1`}
                        aria-label="Target folder"
                      >
                        <option value="">Choose a folder…</option>
                        {folderOptions(rule.accountId).map(f => <option key={f.path} value={f.path}>{f.name}</option>)}
                      </select>
                    )}
                    <button
                      onClick={() => patch(rule.id, { actions: rule.actions.filter((_, j) => j !== i) })}
                      disabled={rule.actions.length === 1}
                      className="text-ink-3 hover:text-danger px-1.5 disabled:opacity-30"
                      aria-label="Remove action"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => patch(rule.id, { actions: [...rule.actions, { type: 'star' }] })}
                    className="text-[11px] text-info"
                  >
                    + Add action
                  </button>
                  <label className="flex items-center gap-1.5 text-[11px] text-ink-2 ">
                    <input
                      type="checkbox"
                      checked={!!rule.stopProcessing}
                      onChange={e => patch(rule.id, { stopProcessing: e.target.checked })}
                      className="accent-accent"
                    />
                    Stop after this rule
                  </label>
                  <button onClick={() => handlePreview(rule)} className="text-[11px] text-ai ml-auto">
                    {previews[rule.id] === 'loading'
                      ? 'Testing…'
                      : previews[rule.id] !== undefined
                        ? `Matches ${previews[rule.id]} of ${emails.length} loaded`
                        : 'Test against loaded mail'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-line flex-shrink-0">
          <button onClick={() => setRules(rs => [...rs, newRule()])} className="px-3 py-2 rounded-md text-xs font-semibold border border-line text-ink ">
            + Add rule
          </button>
          <button onClick={handleRunNow} className="px-3 py-2 rounded-md text-xs font-semibold border border-line text-ink ">
            Run on loaded mail
          </button>
          <div className="flex-1" />
          <button onClick={() => setShowRulesModal(false)} className="px-3 py-2 rounded-md text-xs text-ink-2 ">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-md bg-accent text-xs font-bold text-[#201500] hover:bg-accent disabled:opacity-50">
            {saving ? 'Saving…' : 'Save rules'}
          </button>
        </div>
      </div>
    </div>
  )
}
