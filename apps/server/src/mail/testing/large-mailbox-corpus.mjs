import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
function office(path, xml) { return Buffer.from(zipSync({ [path]: [strToU8(xml), { mtime: new Date(1980, 0, 1) }] }, { level: 0 })); }
function pdf(text) {
    const stream = 'BT /F1 12 Tf 20 100 Td (' + text + ') Tj ET', objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream'];
    let raw = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(raw)); raw += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
    const xref = Buffer.byteLength(raw);
    raw += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return Buffer.from(raw);
}
export const CORPUS_VERSION = 'legal-100k-v3';
const pad = n => String(n).padStart(6, '0');
export function benchmarkMessage(index) {
    const accountId = ['benchmark-a', 'benchmark-b', 'benchmark-c'][index % 3], sourceId = 'message-' + pad(index), locator = { provider: 'gmail', messageId: sourceId };
    const old = index % 10 === 0 || index % 1000 === 11, attachment = index % 10 === 1, embedded = index % 1000 === 2, malformed = index % 1000 === 3;
    const date = new Date(Date.UTC(old ? 2001 : 2020 + index % 7, index % 12, 1 + index % 28, 12)).toISOString();
    const identifier = 'AZ-' + pad(index) + '/34.5', kind = embedded ? 'embedded' : attachment ? 'attachment' : malformed ? 'malformed-duplicate-content-type' : 'plain';
    const bodySize = index % 1000 === 9 ? 65536 : index % 100 === 9 ? 16384 : index % 10 === 9 ? 4096 : 768;
    const text = `Record ${pad(index)} ${identifier}. Prüfung Größe Kündigung. ${old ? 'Historical evidence.' : 'Current correspondence.'} ` + 'Contract diligence obligation '.repeat(Math.ceil(bodySize / 29));
    const attachmentSize = index % 1000 === 1 ? 262144 : index % 100 === 1 ? 32768 : 2048;
    const attachmentText = `AttachmentEvidence${pad(index)} Evidence only in unopened document. ${identifier} ` + 'Verträge Rechtsberatung '.repeat(Math.ceil(attachmentSize / 24));
    let attached = attachment ? Buffer.from(attachmentText) : embedded ? Buffer.from(`From: embedded@example.invalid\r\nTo: reader@example.invalid\r\nSubject: Embedded evidence ${pad(index)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nEmbeddedRecord${pad(index)}`) : null;
    const format = index % 100 === 31 ? 'docx' : index % 100 === 41 ? 'xlsx' : index % 100 === 51 ? 'pdf' : 'txt';
    if (attachment && format === 'docx')
        attached = office('word/document.xml', '<w:document xmlns:w="urn:w"><w:p><w:r><w:t>AttachmentEvidence' + pad(index) + ' Vertrag ' + identifier + '</w:t></w:r></w:p></w:document>');
    if (attachment && format === 'xlsx')
        attached = office('xl/worksheets/sheet1.xml', '<worksheet><row><c t="inlineStr"><is><t>AttachmentEvidence' + pad(index) + ' Vertrag ' + identifier + '</t></is></c></row></worksheet>');
    if (attachment && format === 'pdf')
        attached = pdf('AttachmentEvidence' + pad(index) + ' Contract ' + identifier);
    const boundary = 'benchmark-' + pad(index), filename = attachment ? 'Prüfung-' + pad(index) + '.' + format : embedded ? 'forwarded-' + pad(index) + '.eml' : null;
    const headers = [`From: Partner <partner${index % 100}@example.invalid>`, `To: Group: reader@example.invalid, associate${index % 10}@example.invalid;`, `Date: ${new Date(date).toUTCString()}`, `Subject: =?UTF-8?B?${Buffer.from('Prüfung ' + identifier).toString('base64')}?=`, ...(index % 20 === 0 ? [] : [`Message-ID: <duplicate-${Math.floor(index / 6)}@example.invalid>`]), 'MIME-Version: 1.0', ...(malformed ? ['Content-Type: text/html'] : [])];
    const content = attached ? [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', text, `--${boundary}`, `Content-Type: ${attachment ? (format === 'txt' ? 'text/plain; charset=utf-8' : format === 'pdf' ? 'application/pdf' : 'application/octet-stream') : 'message/rfc822'}`, `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Content-Transfer-Encoding: base64', '', attached.toString('base64').match(/.{1,76}/g).join('\r\n'), `--${boundary}--`, ''] : [...headers, 'Content-Type: text/plain; charset=utf-8', '', text, ''];
    const raw = Buffer.from(content.join('\r\n'));
    return { index, accountId, locator, date, identifier, kind, format: embedded ? 'eml' : attachment ? format : null, malformed, filename, raw, attached, memberships: old ? ['Archive/2001/Mandate/Verträge'] : index % 4 === 0 ? ['INBOX', 'UNREAD', 'Contracts'] : ['INBOX'], hash: createHash('sha256').update(raw).digest('hex') };
}
export function qualityQueries(count) {
    const last = Math.max(0, count - 1), attachment = Math.min(count - 1, 11), old = 0, projected = count - Math.max(0, Math.ceil((count - 3) / 1000));
    return [
        { name: 'common-keyword', input: { keywords: ['diligence'] }, expected: projected },
        { name: 'german-umlaut', input: { keywords: ['Kündigung'] }, expected: projected },
        { name: 'phrase', input: { phrase: 'Contract diligence obligation' }, expected: projected },
        { name: 'old-mail', input: { beforeDate: '2002-01-01T00:00:00.000Z' }, expected: Math.ceil(count / 10) + Math.max(0, Math.ceil((count - 11) / 1000)) },
        { name: 'exact-identifier-old', input: { matterIdentifier: benchmarkMessage(old).identifier }, expected: 1 },
        { name: 'exact-identifier-last', input: { matterIdentifier: benchmarkMessage(last).identifier }, expected: 1 },
        { name: 'attachment-only', input: { keywords: ['AttachmentEvidence' + pad(attachment)] }, expected: 1, attachment: true },
        ...['docx', 'xlsx', 'pdf'].map((format, index) => ({ name: format + '-attachment', input: { keywords: ['AttachmentEvidence' + pad(31 + index * 10)] }, expected: 1, attachment: true })),
        { name: 'exact-filename', input: { filename: 'Prüfung-' + pad(attachment) + '.txt' }, expected: 1 },
        { name: 'exact-sender', input: { sender: 'partner0@example.invalid' }, expected: Math.ceil(count / 100) },
        { name: 'negative-address', input: { sender: 'partner0@example.invalid.evil' }, expected: 0 },
        { name: 'negative-punctuation', input: { literal: 'AZ 000000 34 5' }, expected: 0 },
        { name: 'account-and-unread', input: { accountIds: ['benchmark-a'], unread: true }, expected: Array.from({ length: count }, (_, i) => i).filter(i => i % 3 === 0 && i % 4 === 0 && i % 10 !== 0).length },
    ];
}
