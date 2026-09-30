/** `Hallo-ee006b29.md` is "Hallo"; its conflict copy `Hallo-ee006b29 (Anna, 2026-09-27 14.06).md` "Hallo (Anna, 2026-09-27 14.06)". */
export function noteTitle(name: string) {
  return name.replace(/\.md$/i, "").replace(/-[a-f0-9]{8}(?=( \([^)]*\))*$)/i, "");
}

/** Project notes keep a collision-safe filename; show their title in the UI. */
export function projectFileDisplayName(path: string, name: string) {
  const note = /^Notes\/([^/]+\.md)$/i.exec(path.replaceAll("\\", "/"));
  return note ? noteTitle(note[1]) : name;
}
