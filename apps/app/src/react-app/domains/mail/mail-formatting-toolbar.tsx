import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Bold, Italic, Underline, List, ListOrdered, Quote, Link, Unlink, RemoveFormatting } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { composeLinkUrl } from './mail-formatting';

const formats = [
  { command: 'bold', icon: Bold, label: 'mail.format_bold' },
  { command: 'italic', icon: Italic, label: 'mail.format_italic' },
  { command: 'underline', icon: Underline, label: 'mail.format_underline' },
  { command: 'insertUnorderedList', icon: List, label: 'mail.format_bullets' },
  { command: 'insertOrderedList', icon: ListOrdered, label: 'mail.format_numbers' },
];

export function MailFormattingToolbar({ editor, disabled, onChange }: { editor: RefObject<HTMLDivElement | null>; disabled: boolean; onChange: () => void }) {
  const range = useRef<Range | null>(null), urlField = useRef<HTMLInputElement>(null), id = useId();
  const [pressed, setPressed] = useState<string[]>([]), [link, setLink] = useState<{ text: string; url: string }>(), [error, setError] = useState('');
  useEffect(() => {
    const selectionChanged = () => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !editor.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
      range.current = selection.getRangeAt(0).cloneRange();
      setPressed(formats.filter(format => document.queryCommandState(format.command)).map(format => format.command));
    };
    document.addEventListener('selectionchange', selectionChanged);
    document.addEventListener('keyup', selectionChanged);
    return () => { document.removeEventListener('selectionchange', selectionChanged); document.removeEventListener('keyup', selectionChanged); };
  }, [editor]);
  function restore() {
    const element = editor.current, selection = window.getSelection();
    if (!element || !selection || disabled) return false;
    element.focus({ preventScroll: true });
    const saved = range.current;
    const next = saved && element.contains(saved.startContainer) && element.contains(saved.endContainer) ? saved : document.createRange();
    if (next !== saved) { next.selectNodeContents(element); next.collapse(false); }
    selection.removeAllRanges(); selection.addRange(next);
    return true;
  }
  function apply(command: string, value?: string) {
    if (!restore()) return;
    // Keep the native undo history and emit only markup accepted by the mail sanitizer.
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(command, false, value);
    onChange();
  }
  function openLink() {
    if (disabled) return;
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) range.current = selection.getRangeAt(0).cloneRange();
    setError(''); setLink({ text: range.current?.toString() ?? '', url: '' });
  }
  function insertLink() {
    if (!link || disabled) return;
    const url = composeLinkUrl(link.url);
    if (!url) { setError(t('mail.format_link_invalid')); return; }
    const anchor = document.createElement('a'); anchor.href = url; anchor.textContent = link.text.trim() || url;
    apply('insertHTML', anchor.outerHTML); setLink(undefined);
  }
  return <>
    <div role="group" aria-label={t('mail.formatting')} className="flex flex-wrap items-center gap-1">
      {formats.map(({ command, icon: Icon, label }) => <Button key={command} variant="ghost" size="icon-sm" className={pressed.includes(command) ? 'bg-accent text-accent-foreground' : undefined} title={t(label)} aria-label={t(label)} aria-pressed={pressed.includes(command)} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => apply(command)}><Icon size={15} /></Button>)}
      <Button variant="ghost" size="icon-sm" title={t('mail.format_quote')} aria-label={t('mail.format_quote')} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => apply('formatBlock', 'blockquote')}><Quote size={15} /></Button>
      <Button variant="ghost" size="icon-sm" title={t('mail.format_link')} aria-label={t('mail.format_link')} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={openLink}><Link size={15} /></Button>
      <Button variant="ghost" size="icon-sm" title={t('mail.format_unlink')} aria-label={t('mail.format_unlink')} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => apply('unlink')}><Unlink size={15} /></Button>
      <Button variant="ghost" size="icon-sm" title={t('mail.format_clear')} aria-label={t('mail.format_clear')} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => apply('removeFormat')}><RemoveFormatting size={15} /></Button>
    </div>
    <Dialog open={!!link} onOpenChange={open => { if (!open) setLink(undefined); }}><DialogContent initialFocus={urlField} finalFocus={editor} onKeyDownCapture={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); } }}>
      <DialogHeader><DialogTitle>{t('mail.format_link')}</DialogTitle></DialogHeader>
      <div className="grid gap-4">
        <div className="grid gap-1.5"><Label htmlFor={`${id}-text`}>{t('mail.format_link_text')}</Label><Input id={`${id}-text`} value={link?.text ?? ''} onChange={event => setLink(current => current && { ...current, text: event.target.value })} /></div>
        <div className="grid gap-1.5"><Label htmlFor={`${id}-url`}>{t('mail.format_link_url')}</Label><Input ref={urlField} id={`${id}-url`} type="url" placeholder="https://" value={link?.url ?? ''} onChange={event => { setError(''); setLink(current => current && { ...current, url: event.target.value }); }} /></div>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      <DialogFooter><Button variant="ghost" onClick={() => setLink(undefined)}>{t('common.cancel')}</Button><Button disabled={disabled} onClick={insertLink}>{t('mail.format_link_insert')}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
