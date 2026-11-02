export type MailActionControls = {
  disabled: boolean;
  moveDisabled: boolean;
  label: string;
  destinations: Array<{id: string; name: string}>;
  move: (id: string) => void;
  remove: () => void;
};
const controls = new WeakMap<Element, MailActionControls>();
export function registerMailActionControls(element: Element | null, value: MailActionControls) {
  if (element) controls.set(element, value);
}
export function mailActionControls(root: Element | null) {
  const element = root?.querySelector('[data-mail-actions]');
  return element ? controls.get(element) : undefined;
}
