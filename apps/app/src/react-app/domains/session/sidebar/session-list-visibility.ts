import { useSyncExternalStore } from "react";

// Only chats created by this UI are provisional. Never infer emptiness from a
// default title: an older chat, fork, or agent-created chat can have real work.
const PREFIX = "legalwork.session-list.v1:";
const records = new Map<string, "empty" | "used">();
const listeners = new Set<() => void>();
let revision = 0;
const emit = () => { revision++; listeners.forEach(listener => listener()); };

function read(id: string) {
  if (records.get(id) === "used") return "used";
  try {
    const value = window.localStorage.getItem(PREFIX + id);
    if (value === "empty" || value === "used") return value;
  } catch { /* In-memory behavior still works when storage is unavailable. */ }
  return records.get(id);
}
function write(id: string, value: "empty" | "used") {
  if (!id || read(id) === value) return;
  records.set(id, value);
  try { window.localStorage.setItem(PREFIX + id, value); } catch { /* Keep in memory. */ }
  emit();
}
export function registerEmptySession(id: string) {
  // A send/draft event may beat the create response. Promotion is monotonic.
  if (read(id) !== "used") write(id, "empty");
}
export function retainSessionInLists(id: string) {
  write(id, "used");
}
export function isSessionListed(id: string) { return read(id) !== "empty"; }
export function useSessionListRevision() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => revision, () => 0);
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === null || event.key.startsWith(PREFIX)) {
    if (event.key === null) records.clear();
    else records.delete(event.key.slice(PREFIX.length));
    emit();
  }
});
