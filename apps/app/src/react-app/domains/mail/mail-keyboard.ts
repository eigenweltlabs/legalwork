/** Contextual Mail shortcuts only; editable controls and global shell commands retain ownership. */
export function mailKeyboard(event: KeyboardEvent, root: HTMLElement) {
    if (event.defaultPrevented || event.isComposing || event.altKey)
        return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !root.contains(target))
        return;
    const editable = target.isContentEditable || !!target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]');
    const click = (selector: string) => { const button = root.querySelector(selector); if (!(button instanceof HTMLButtonElement) || button.disabled)
        return false; button.click(); return true; };
    let handled = false;
    if (event.key === 'Escape' && target.matches('[aria-label="Search mail"]')) {
        handled = click('[aria-label="Clear search"]');
    }
    else if (editable)
        return;
    else if ((!event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === '/') || (!event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f')) {
        const input = root.querySelector('[aria-label="Search mail"]');
        if (input instanceof HTMLInputElement && !input.disabled) {
            input.focus();
            handled = true;
        }
    }
    else if (event.ctrlKey || event.metaKey)
        return;
    else if (event.key.toLowerCase() === 'c' && !event.shiftKey)
        handled = click('[aria-label="Compose"]');
    else if (event.key.toLowerCase() === 'r')
        handled = click(event.shiftKey ? '[aria-label="Reply all"]' : '[aria-label="Reply"]');
    else if (!event.shiftKey && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && target.closest('.mail-message-scroll')) {
        const rows = [...root.querySelectorAll<HTMLButtonElement>('.mail-message-row')], at = rows.findIndex(row => row === target.closest('button'));
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)));
        const button = rows[next];
        if (button) {
            button.focus();
            button.scrollIntoView({ block: 'nearest' });
            button.click();
            handled = true;
        }
    }
    if (handled) {
        event.preventDefault();
        event.stopPropagation();
    }
}
