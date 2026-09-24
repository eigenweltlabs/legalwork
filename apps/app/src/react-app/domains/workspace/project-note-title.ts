export function noteTitle(name: string) {
  return name.replace(/-[a-f0-9]{8}\.md$/i, "").replace(/\.md$/i, "");
}

/** Project notes keep a collision-safe filename; show their title in the UI. */
export function projectFileDisplayName(path: string, name: string) {
  const note = /^Notes\/([^/]+\.md)$/i.exec(path.replaceAll("\\", "/"));
  return note ? noteTitle(note[1]) : name;
}
