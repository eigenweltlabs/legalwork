import JSZip from 'jszip';

// JSZip 3.10.1 exposes this browser stream API but omits it from JSZipObject's declarations.
interface ZipStream {
  on(event: 'data', callback: (chunk: Uint8Array) => void): ZipStream;
  on(event: 'error', callback: (error: Error) => void): ZipStream;
  on(event: 'end', callback: () => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
}
declare module 'jszip' { interface JSZipObject { internalStream(type: 'uint8array'): ZipStream; } }

/** Reject active/linked Office content before giving a package to the existing read-only viewer. */
export async function verifyMailDocx(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
  const reject = () => { throw Error('This Word attachment cannot be previewed safely. Use Save instead.'); };
  // Bound expansion using the ZIP central directory before any decompression.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) reject();
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (!count || count > 2048 || start + size !== end || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) reject();
  let cursor = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) reject();
    const length = view.getUint32(cursor + 24, true);
    total += length;
    if (length > 16 * 1024 * 1024 || total > 64 * 1024 * 1024 || view.getUint16(cursor + 8, true) & 1) reject();
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  if (cursor !== end) reject();
  const zip = await JSZip.loadAsync(bytes);
  if (!zip.file('word/document.xml')) reject();
  let actualTotal = 0;
  for (const file of Object.values(zip.files)) {
    if (signal.aborted) throw Error('Mail preview cancelled.');
    if (/\.(?:bin|html?|svg)$/i.test(file.name) || /(?:embeddings|activeX)\//i.test(file.name)) reject();
    let expanded = 0;
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve, fail) => {
      const stream = file.internalStream('uint8array');
      stream.on('data', chunk => {
        expanded += chunk.length;
        if (signal.aborted || expanded > 16 * 1024 * 1024) { stream.pause(); fail(Error('Mail preview limit exceeded.')); return; }
        chunks.push(chunk);
      }).on('error', fail).on('end', resolve).resume();
    });
    actualTotal += expanded;
    if (actualTotal > 64 * 1024 * 1024) reject();
    if (!/\.(xml|rels)$/i.test(file.name)) continue;
    const data = new Uint8Array(expanded); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true }).decode(data);
    // No external relationships, field instructions, alternate HTML chunks or entities.
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    for (const node of Array.from(xml.getElementsByTagName('*'))) {
      if (['parsererror', 'instrText', 'fldSimple', 'altChunk'].includes(node.localName) || node.getAttribute('TargetMode')?.toLowerCase() === 'external') reject();
    }
    if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']|<(?:\w+:)?(?:instrText|fldSimple|altChunk)\b/i.test(text)) reject();
  }
  if (signal.aborted) throw Error('Mail preview cancelled.');
}

/** The editable Word viewer loads remote fonts; mail uses its existing parser's text projection. */
export async function mailDocxText(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
  await verifyMailDocx(bytes, signal);
  const { DocxReviewer } = await import('@eigenpal/docx-editor-agents');
  const document = await DocxReviewer.fromBuffer(bytes.buffer);
  const text = document.getContentAsText();
  if (signal.aborted) throw Error('Mail preview cancelled.');
  if (text.length > 8 * 1024 * 1024) throw Error('Word text preview exceeds the reader limit. Use Save instead.');
  return new TextEncoder().encode(text);
}
