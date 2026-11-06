import { useEditor } from '@tiptap/react'
import Underline from '@tiptap/extension-underline'
import { promptDialog } from '../DialogHost'
import { t as translate } from '../../lib/i18n'

export function RichToolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null

  const btn = (active: boolean) =>
    `px-1.5 py-1 rounded text-xs font-semibold transition-colors ${
      active
        ? 'bg-surface-3 text-ink '
        : 'text-ink-3 hover:bg-surface-3 hover:text-ink '
    }`

  const setLink = async () => {
    const prev = editor.getAttributes('link').href
    const url = await promptDialog({
      title: prev ? translate('Edit link') : translate('Insert link'),
      label: translate('Destination'),
      defaultValue: prev || 'https://',
      confirmLabel: prev ? translate('Update') : translate('Insert'),
    })
    // Cancelling leaves the document alone; clearing the field removes the
    // link, which is the only way to unlink from this button.
    if (url === null) return
    if (!url) { editor.chain().focus().unsetLink().run(); return }
    editor.chain().focus().setLink({ href: url }).run()
  }

  return (
    <div className="flex items-center gap-0.5 px-3 py-2 border-b border-line/40">
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} className={btn(editor.isActive('bold'))} title={translate('Bold')}>B</button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} className={`${btn(editor.isActive('italic'))} italic`} title={translate('Italic')}>I</button>
      <button type="button" onClick={() => editor.chain().focus().toggleUnderline().run()} className={`${btn(editor.isActive('underline'))} underline`} title={translate('Underline')}>U</button>
      <div className="w-px h-4 bg-line mx-1" />
      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} className={btn(editor.isActive('bulletList'))} title={translate('Bullet list')}>
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="2" cy="3.5" r="1" fill="currentColor"/><line x1="5" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="2" cy="7" r="1" fill="currentColor"/><line x1="5" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><circle cx="2" cy="10.5" r="1" fill="currentColor"/><line x1="5" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} className={btn(editor.isActive('orderedList'))} title={translate('Numbered list')}>
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><text x="0" y="5" fontSize="5" fill="currentColor">1.</text><line x1="5" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><text x="0" y="9" fontSize="5" fill="currentColor">2.</text><line x1="5" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><text x="0" y="13" fontSize="5" fill="currentColor">3.</text><line x1="5" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
      </button>
      <div className="w-px h-4 bg-line mx-1" />
      <button type="button" onClick={setLink} className={btn(editor.isActive('link'))} title={translate('Insert link')}>
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M5.5 8.5a3.5 3.5 0 005 0l2-2a3.5 3.5 0 00-5-5L6.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><path d="M8.5 5.5a3.5 3.5 0 00-5 0l-2 2a3.5 3.5 0 005 5l1-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
      </button>
    </div>
  )
}
