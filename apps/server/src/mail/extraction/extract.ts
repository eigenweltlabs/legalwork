import { Unzip, UnzipInflate } from 'fflate';
import { SaxesParser } from 'saxes';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { EXTRACTION_LIMITS as LIMIT, EXTRACTION_VERSION, ExtractionError, extractedSchema, type ExtractedText } from './contract.js';
const require = createRequire(import.meta.url);
const utf8 = new TextDecoder('utf-8', { fatal: true });
function decode(bytes: Uint8Array): string {
    if (bytes[0] === 255 && bytes[1] === 254)
        return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    if (bytes[0] === 254 && bytes[1] === 255)
        return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    return utf8.decode(bytes);
}
function xmlEvents(xml: string, onText: (text: string, stack: string[]) => void, onClose?: (tag: string) => void, onOpen?: (tag: string, attributes: Record<string, string>) => void) {
    const parser = new SaxesParser({ xmlns: false }), stack: string[] = [];
    parser.on('doctype', () => { throw new ExtractionError('unsupported'); });
    parser.on('opentag', tag => { const name = tag.name.split(':').at(-1) ?? tag.name; stack.push(name); const attributes: Record<string, string> = {}; for (const [key, value] of Object.entries(tag.attributes))
        if (typeof value === 'string')
            attributes[key] = value; onOpen?.(name, attributes); });
    parser.on('text', text => onText(text, stack));
    parser.on('cdata', text => onText(text, stack));
    parser.on('closetag', () => { onClose?.(stack.pop() ?? ''); });
    parser.write(xml).close();
}
function office(bytes: Uint8Array, extension: string): ExtractedText['sections'] {
    const entries = new Map<string, string>();
    let expanded = 0, count = 0;
    // Local-file encryption flag. No password prompt or external decryptor is invoked.
    if (bytes.length >= 8 && (bytes[6] & 1))
        throw new ExtractionError('encrypted');
    const unzip = new Unzip(file => {
        if (++count > LIMIT.entries)
            throw new ExtractionError('limit');
        if (entries.has(file.name) || file.name.includes('..') || file.name.startsWith('/'))
            throw new ExtractionError('malformed');
        const selected = extension === '.docx' ? /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(file.name) : extension === '.pptx' ? /^ppt\/slides\/slide\d+\.xml$/.test(file.name) : /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(file.name);
        if (!selected)
            return;
        if (file.originalSize !== undefined && file.originalSize > LIMIT.entryBytes)
            throw new ExtractionError('limit');
        const chunks: Uint8Array[] = [];
        let size = 0;
        file.ondata = (error, chunk, final) => { if (error)
            throw new ExtractionError('malformed'); size += chunk.length; expanded += chunk.length; if (size > LIMIT.entryBytes || expanded > LIMIT.expandedBytes) {
            file.terminate();
            throw new ExtractionError('limit');
        } chunks.push(chunk); if (final)
            entries.set(file.name, decode(Buffer.concat(chunks))); };
        file.start();
    });
    unzip.register(UnzipInflate);
    // Small compressed input chunks bound the work performed before expanded-byte checks.
    for (let offset = 0; offset < bytes.length; offset += 1024)
        unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
    if (extension === '.docx' && !entries.has('word/document.xml'))
        throw new ExtractionError('malformed');
    if (!entries.size)
        throw new ExtractionError('malformed');
    const sections: ExtractedText['sections'] = [];
    const shared: string[] = [];
    if (entries.has('xl/sharedStrings.xml')) {
        let value = '';
        xmlEvents(entries.get('xl/sharedStrings.xml') ?? '', (text, stack) => { if (stack.at(-1) === 't')
            value += text; }, tag => { if (tag === 'si') {
            shared.push(value);
            value = '';
        } });
    }
    for (const [name, xml] of [...entries].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
        if (name === 'xl/sharedStrings.xml')
            continue;
        let text = '';
        if (extension === '.xlsx') {
            let cell = '', type = '';
            xmlEvents(xml, (value, stack) => { if (stack.at(-1) === 'v' || stack.at(-1) === 't')
                cell += value; }, tag => {
                if (tag === 'c') {
                    if (type === 's') {
                        if (!/^\d+$/.test(cell) || shared[Number(cell)] === undefined)
                            throw new ExtractionError('malformed');
                        text += shared[Number(cell)];
                    }
                    else
                        text += cell;
                    text += '\t';
                    cell = '';
                }
                if (tag === 'row')
                    text += '\n';
            }, (tag, attributes) => { if (tag === 'c') {
                cell = '';
                type = attributes.t ?? '';
            } });
        }
        else
            xmlEvents(xml, (value, stack) => { if (stack.at(-1) === 't')
                text += value; }, tag => { if (tag === 'p')
                text += '\n'; }, tag => { if (tag === 'tab')
                text += '\t'; if (tag === 'br')
                text += '\n'; });
        sections.push({ source: name, method: 'text', text: text.trim() });
    }
    return sections;
}
async function ocr() {
    const { createWorker, OEM } = await import('tesseract.js');
    const languages = await Promise.all(['deu', 'eng'].map(async (code) => ({ code, data: await readFile(join(dirname(require.resolve('@tesseract.js-data/' + code + '/package.json')), '4.0.0_best_int', code + '.traineddata.gz')) })));
    // Direct local model bytes mean there is no language URL, download or cache path.
    return createWorker(languages, OEM.LSTM_ONLY, { cacheMethod: 'none', logger: () => { }, errorHandler: () => { } });
}
async function pdf(bytes: Uint8Array): Promise<ExtractedText['sections']> {
    const { PDFDocument, PDFRawStream, PDFName, PDFNumber } = await import('pdf-lib');
    let preflight;
    try {
        preflight = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    }
    catch (error) {
        if (error instanceof Error && error.message.includes('encrypted'))
            throw new ExtractionError('encrypted');
        throw error;
    }
    if (preflight.getPageCount() > LIMIT.pages)
        throw new ExtractionError('limit');
    for (const [, object] of preflight.context.enumerateIndirectObjects())
        if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
            const width = object.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber(), height = object.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber();
            if (!Number.isSafeInteger(width * height) || width < 1 || height < 1 || width * height > LIMIT.pixels)
                throw new ExtractionError('limit');
        }
    const { getDocument, PasswordException, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = await import('@napi-rs/canvas');
    const assets = dirname(require.resolve('pdfjs-dist/package.json'));
    const parameters = { isEvalSupported: false, standardFontDataUrl: join(assets, 'standard_fonts') + '/', wasmUrl: join(assets, 'wasm') + '/', iccUrl: join(assets, 'iccs') + '/', data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, maxImageSize: LIMIT.pixels, canvasMaxAreaInBytes: LIMIT.pixels * 4, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, stopAtErrors: true, verbosity: 0 };
    const loading = getDocument(parameters);
    let document;
    let worker: Awaited<ReturnType<typeof ocr>> | undefined;
    try {
        try {
            document = await loading.promise;
        }
        catch (error) {
            if (error instanceof PasswordException)
                throw new ExtractionError('encrypted');
            throw error;
        }
        if (document.numPages > LIMIT.pages)
            throw new ExtractionError('limit');
        const sections: ExtractedText['sections'] = [];
        for (let index = 1; index <= document.numPages; index++) {
            const page = await document.getPage(index);
            const content = await page.getTextContent();
            let text = content.items.map(item => 'str' in item ? item.str : '').join(' ').trim();
            let method: 'text' | 'ocr' = 'text';
            const operators = await page.getOperatorList();
            const raster = operators.fnArray.some(operation => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup].includes(operation));
            if (raster && text)
                sections.push({ source: 'page:' + index, method: 'text', text });
            if (!text || raster) {
                const viewport = page.getViewport({ scale: 2 }), width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
                if (!Number.isSafeInteger(width * height) || width < 1 || height < 1 || width * height > LIMIT.pixels)
                    throw new ExtractionError('limit');
                const canvas = createCanvas(width, height);
                // PDF.js declares browser Canvas types; its supported Node canvas implements this surface.
                await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
                worker ??= await ocr();
                text = (await worker.recognize(canvas.toBuffer('image/png'))).data.text.trim();
                method = 'ocr';
                canvas.width = 1;
                canvas.height = 1;
            }
            sections.push({ source: 'page:' + index, method, text });
            page.cleanup();
            if (Buffer.byteLength(JSON.stringify(sections)) > LIMIT.outputBytes)
                throw new ExtractionError('limit');
        }
        return sections;
    }
    finally {
        await worker?.terminate();
        await loading.destroy();
    }
}
function dimensions(bytes: Uint8Array): {
    width: number;
    height: number;
} | null {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (data[0] === 255 && data[1] === 216) {
        let offset = 2;
        while (offset + 4 < data.length) {
            if (data[offset] !== 255)
                throw new ExtractionError('malformed');
            const marker = data[offset + 1];
            if (marker === 217 || marker === 218)
                break;
            const length = data.readUInt16BE(offset + 2);
            if (length < 2 || offset + length + 2 > data.length)
                throw new ExtractionError('malformed');
            if ([192, 193, 194].includes(marker)) {
                if (length < 8)
                    throw new ExtractionError('malformed');
                return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
            }
            offset += length + 2;
        }
    }
    return null;
}
export async function extractAttachment(bytes: Uint8Array, filename: string, contentType: string): Promise<ExtractedText> {
    if (bytes.length > LIMIT.inputBytes)
        throw new ExtractionError('limit');
    try {
        const extension = extname(filename).toLowerCase();
        let sections: ExtractedText['sections'];
        if (Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-')
            sections = await pdf(bytes);
        else if (['.docx', '.xlsx', '.pptx'].includes(extension))
            sections = office(bytes, extension);
        else if (['.png', '.jpg', '.jpeg'].includes(extension) || ['image/png', 'image/jpeg'].includes(contentType)) {
            const size = dimensions(bytes);
            if (!size)
                throw new ExtractionError('malformed');
            if (size.width < 1 || size.height < 1 || size.width * size.height > LIMIT.pixels)
                throw new ExtractionError('limit');
            const worker = await ocr();
            try {
                sections = [{ source: 'image:1', method: 'ocr', text: (await worker.recognize(Buffer.from(bytes))).data.text.trim() }];
            }
            finally {
                await worker.terminate();
            }
        }
        else if (['.txt', '.md', '.csv', '.tsv', '.json', '.xml'].includes(extension) || contentType === 'text/plain') {
            const text = decode(bytes);
            if (text.includes('\0'))
                throw new ExtractionError('malformed');
            sections = [{ source: 'text', method: 'text', text }];
        }
        else
            throw new ExtractionError('unsupported');
        const parsed = extractedSchema.safeParse({ version: EXTRACTION_VERSION, sections });
        if (!parsed.success)
            throw new ExtractionError('limit');
        return parsed.data;
    }
    catch (error) {
        if (error instanceof ExtractionError)
            throw error;
        if (error instanceof Error && error.message.includes('Image exceeded maximum allowed size'))
            throw new ExtractionError('limit');
        throw new ExtractionError('malformed');
    }
}
