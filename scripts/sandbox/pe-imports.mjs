/** Read PE import tables without requiring a second compiler on build hosts. */
export function peImports(bytes) {
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid PE file');
  const optional = pe + 24;
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error('Unsupported PE optional header');
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const sectionTable = optional + bytes.readUInt16LE(pe + 20);
  const sections = [];
  for (let index = 0; index < bytes.readUInt16LE(pe + 6); index++) {
    const at = sectionTable + index * 40;
    sections.push({ address: bytes.readUInt32LE(at + 12), size: bytes.readUInt32LE(at + 16), offset: bytes.readUInt32LE(at + 20) });
  }
  function offset(address) {
    const section = sections.find((entry) => address >= entry.address && address < entry.address + entry.size);
    if (!section) throw new Error('PE import points outside a file section');
    return section.offset + address - section.address;
  }
  const names = new Set();
  for (const [directory, stride, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
    const address = bytes.readUInt32LE(directories + directory * 8);
    const size = bytes.readUInt32LE(directories + directory * 8 + 4);
    if (!address) continue;
    const start = offset(address);
    for (let at = start; at + stride <= start + size; at += stride) {
      const nameAddress = bytes.readUInt32LE(at + nameOffset);
      if (!nameAddress) break;
      if (directory === 13 && bytes.readUInt32LE(at) !== 1) throw new Error('Unsupported legacy delay import');
      const nameStart = offset(nameAddress), end = bytes.indexOf(0, nameStart);
      if (end < nameStart || end - nameStart > 256) throw new Error('Invalid PE library name');
      const name = bytes.toString('ascii', nameStart, end);
      if (!/^[a-zA-Z0-9_.+-]+\.(dll|drv)$/i.test(name)) throw new Error(`Unsafe PE library name: ${JSON.stringify(name)}`);
      names.add(name);
    }
  }
  return [...names];
}
