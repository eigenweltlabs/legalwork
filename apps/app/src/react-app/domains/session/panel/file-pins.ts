import { useSyncExternalStore } from "react";
import type { LegalMemoryTreeFile } from "@/app/lib/legalwork-server";

export type FilePin = { workspaceId: string; source: string; path: string; name: string; memory?: LegalMemoryTreeFile };
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isFilePin(value: unknown): value is FilePin {
  if (!isRecord(value) || ![value.workspaceId, value.source, value.path, value.name].every(field => typeof field === "string" && field.length > 0)) return false;
  if (value.memory === undefined) return true;
  const memory = value.memory;
  return isRecord(memory) && [memory.source_object_id, memory.source_id, memory.name, memory.path, memory.document_id].every(field => typeof field === "string") &&
    (memory.mime_type === null || typeof memory.mime_type === "string") && (memory.size_bytes === null || typeof memory.size_bytes === "number") && (memory.mtime === null || typeof memory.mtime === "string");
}
const KEY = "legalwork.file-pins.v1";
let cache: FilePin[] | undefined;
const listeners = new Set<() => void>();
function load() {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isFilePin) : [];
  }
  catch { return cache ?? []; }
}
function snapshot() { return cache ??= load(); }
function update(change: (pins: FilePin[]) => FilePin[]) {
  // Read before writing so one window does not overwrite another's new pins.
  cache = change(load());
  try { window.localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* Retain for this window. */ }
  listeners.forEach(listener => listener());
}
export const filePinKey = (pin: FilePin) => JSON.stringify([pin.workspaceId, pin.source, pin.path]);
export function toggleFilePin(pin: FilePin) {
  update(pins => pins.some(item => filePinKey(item) === filePinKey(pin))
    ? pins.filter(item => filePinKey(item) !== filePinKey(pin)) : [...pins, pin]);
}
export function updatePinnedPaths(pins: FilePin[], workspaceId: string, source: string, from: string, to?: string): FilePin[] {
  return pins.flatMap(pin => {
    if (pin.workspaceId !== workspaceId || pin.source !== source || (pin.path !== from && !pin.path.startsWith(`${from}/`))) return [pin];
    if (to === undefined) return [];
    const path = to + pin.path.slice(from.length);
    return [{ ...pin, path, name: path.split("/").at(-1) || pin.name }];
  });
}
export function changePinnedPaths(workspaceId: string, source: string, from: string, to?: string) {
  update(pins => updatePinnedPaths(pins, workspaceId, source, from, to));
}
export function useFilePins() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, snapshot, snapshot);
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === KEY || event.key === null) {
    cache = undefined;
    listeners.forEach(listener => listener());
  }
});
