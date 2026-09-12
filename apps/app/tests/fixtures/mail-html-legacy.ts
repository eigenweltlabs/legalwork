import DOMPurify from 'dompurify';
/** Every URL in the input is discarded; only caller-created, verified raster CIDs survive. */
export function mailHtml(html: string, inline: ReadonlyMap<string, string> = new Map()): string {
    const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'h1', 'h2', 'h3', 'h4', 'a', 'img'], ALLOWED_ATTR: ['alt', 'title', 'src', 'colspan', 'rowspan'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
    for (const image of fragment.querySelectorAll('img')) {
        const cid = image.getAttribute('src')?.match(/^cid:(.+)$/i)?.[1];
        const replacement = cid ? inline.get(cid.replace(/^<|>$/g, '')) : undefined;
        if (replacement && /^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/.test(replacement))
            image.setAttribute('src', replacement);
        else {
            const label = document.createElement('span');
            label.textContent = image.getAttribute('alt') ? '[Image: ' + image.getAttribute('alt') + ']' : '[External or unavailable image blocked]';
            image.replaceWith(label);
        }
    }
    const container = document.createElement('div');
    container.append(fragment);
    return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'none\'; connect-src \'none\'; frame-src \'none\'; form-action \'none\'; base-uri \'none\'"><style>body{font:15px system-ui;line-height:1.6;color:#222;overflow-wrap:anywhere;margin:16px}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}pre{white-space:pre-wrap}td,th{padding:4px}</style></head><body>' + container.innerHTML + '</body></html>';
}
export function rasterType(bytes: Uint8Array): string | null {
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value))
        return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
        return 'image/jpeg';
    const start = new TextDecoder('ascii').decode(bytes.subarray(0, 12));
    if (start.startsWith('GIF87a') || start.startsWith('GIF89a'))
        return 'image/gif';
    if (start.startsWith('RIFF') && start.slice(8) === 'WEBP')
        return 'image/webp';
    return null;
}
export function safeFilename(value: string | null, fallback = 'attachment.bin'): string {
    const name = (value ?? fallback).replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 160);
    return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? 'mail-' + (name || fallback) : name;
}
