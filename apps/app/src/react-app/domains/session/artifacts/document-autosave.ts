/** Debounced file saves, with a deadline during continuous typing. A failed
 * write pauses automatic retries until an explicit save or off/on. */
export function createDocumentAutosave({ save, isDirty, onError, delay = 1500, maxWait = 10000 }: {
  save: () => Promise<boolean>;
  isDirty: () => boolean;
  onError: (error: unknown) => void;
  delay?: number;
  maxWait?: number;
}) {
  let enabled = false;
  let paused = false;
  let suspended = false;
  let running = false;
  let firstChange: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const changed = () => {
    if (!enabled || suspended || paused || running || !isDirty()) return;
    firstChange ??= Date.now();
    clear();
    timer = setTimeout(() => { void flush(); }, Math.max(0, Math.min(delay, firstChange + maxWait - Date.now())));
  };
  const flush = async () => {
    clear();
    if (!enabled || suspended || paused || running || !isDirty()) return;
    running = true;
    firstChange = null;
    try {
      if (!await save()) throw new Error("The editor is not ready to save.");
    } catch (error) {
      paused = true;
      if (enabled) onError(error);
    } finally {
      running = false;
      changed(); // Edits made while the write was in flight still need saving.
    }
  };
  return {
    changed, flush,
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      paused = false;
      firstChange = null;
      clear();
      if (value) changed();
    },
    // Temporary ownership/interaction changes must not resume a failed save.
    setSuspended(value: boolean) {
      suspended = value;
      clear();
      firstChange = null;
      if (!value) changed();
    },
    saved() {
      paused = false;
      clear();
      firstChange = null;
      changed();
    },
  };
}
