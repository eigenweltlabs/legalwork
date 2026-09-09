# Bounded MIME projection

[EIG-125](https://linear.app/eigenweltlabs/issue/EIG-125). `mail/mime/project.ts` exports `projectMime`, `MimeProjectionError`, `MimeProjectionInput`, `MimeProjection`, `MimeAttachmentMetadata` and `MimeLimits`. It reads an already durable original, without opening files, choosing accounts, making network requests or modifying that original.

## Contract

```ts
const projection = await projectMime({
  source: originalChunks, // AsyncIterable<Uint8Array> or Iterable<Uint8Array>
  originalSha256,        // lowercase SHA-256 of the stored original
  signal,
  onAttachment: async (metadata, chunks, signal) => {
    // Fully consume <=64 KiB decoded chunks and await the owned durable sink.
    // Treat these writes as provisional until projectMime resolves.
  },
});
```

Result fields are `version:1`, `originalSha256`, `validation:'supported-projection'`, metadata, bodies and attachments. Metadata contains nullable strings `subject`, `from`, `to`, `cc`, `bcc`, `replyTo`, `date`, `messageId`. Addresses are decoded display header strings, not mailbox identities or authentication assertions. Missing/invalid dates become null; no current timestamp is invented. Body entries are `{partId,contentType:'text/plain'|'text/html',text}`. Ordered plain/HTML alternatives are retained; there is no automatic preferred-body choice or conversion between HTML and text.

Attachment metadata is `{partId,filename,contentType,disposition,contentId}`; filename/contentId may be null, disposition is inline or attachment. Returned attachment descriptors additionally contain measured decoded bytes and SHA-256. Content-ID angle brackets are removed, filenames are display metadata only. Inline images retain their CID relationship. `message/rfc822` is an opaque decoded attachment, preserving the embedded message rather than flattening its body/attachments into the containing message.

IDs are `mime-v1:<original-sha256>:part:<node-ordinal>` in deterministic parser traversal order. They are independent of source chunk boundaries, scoped to the exact original and this pinned projection version. A different original has different derived IDs. The streaming original hash is checked at EOF before success. The caller must retain that original and use its own owner/account/ref binding for every sink write.

The awaited sink must consume its iterator completely. A sink that returns early fails; a sink that throws is reported with a fixed error. Some attachments may have been delivered before malformed trailing content or hash mismatch is discovered. **Only a resolved final projection permits the integrating storage layer to publish enumeration/completeness.** Error handling must keep the original and report projection incomplete; this module cannot roll back external sink writes.

## Limits and lifecycle

Source chunks must be nonempty and at most 64 KiB. Limits are configurable positive integers with hard ceilings:

| Budget | Default | Ceiling |
|---|---:|---:|
| Original bytes | 64 MiB | 1 GiB |
| Aggregate headers | 256 KiB | 1 MiB |
| Aggregate decoded body UTF-8 bytes | 2 MiB | 8 MiB |
| One decoded attachment | 32 MiB | 512 MiB |
| All decoded attachments | 64 MiB | 1 GiB |
| MIME nodes / attachments | 1000 / 100 | 2000 / 500 |
| Parsed MIME depth | 16 | 32 |
| Total deadline | 30 seconds | 120 seconds |

Each body's transfer-decoded input also cannot exceed its body-byte budget before charset conversion. Bodies and metadata are bounded in memory; attachments use OSS decoder backpressure and an awaited sink. Node stream buffers and one decoder chunk remain bounded independently of attachment size. This does not bound caller-owned buffers or a sink that chooses to accumulate content. Opaque embedded messages count against attachment bytes, not recursive depth, because their internals are not parsed.

Cancellation/deadline abort the provided signal, destroy parser streams and reject even when a source/sink ignores abort. Revoked chunk generators cannot emit subsequent bytes. An already invoked sink must cooperate with the signal and its own storage lease; this module cannot undo its side effects or forcibly stop synchronous/native code. Worker termination remains the hard limit for noncooperative code. Errors are fixed `mail_mime_<code>` values: invalid_input, limit, timeout, cancelled, malformed, unsupported, source_failed, sink_failed, hash_mismatch. They contain no input bytes or underlying source/sink error text.

## Parser choice and supported policy

Pinned runtime dependencies are `@zone-eu/mailsplit 5.4.16`, `libmime 5.4.3` and `iconv-lite 0.7.3`, mirrored into desktop packaging; `@types/libmime 5.3.0` is development-only. The OSS splitter handles MIME nodes, header structure and streaming transfer decoders. Libmime decodes encoded header words and parameters; iconv-lite incrementally decodes supported text charsets.

MailParser 3.9.23's documented streaming API streams attachments but emits the collected body at the end. Its HTML limit concerns HTML-to-text conversion. Direct use of its underlying splitter lets this wrapper enforce body budgets before collecting text and avoids private MailParser hooks. Sources checked 9 September 2026: [MailParser streaming API](https://nodemailer.com/extras/mailparser), [MailParser pinned source](https://github.com/nodemailer/mailparser/blob/v3.9.23/lib/mail-parser.js), [mailsplit public API](https://github.com/zone-eu/mailsplit/blob/master/README.md), [mailsplit types](https://github.com/zone-eu/mailsplit/blob/master/index.d.ts).

The wrapper rejects invalid/padded/truncated base64 forms, incomplete quoted-printable escapes, unclosed recognized multipart boundaries, duplicate structural headers, unsupported transfer encodings, unknown text charsets. Plain `format=flowed` uses bounded libmime.decodeFlowed; `delsp=yes` removes the soft-break space, `no` retains it. HTML is unchanged. A small pinned splitter comparison hook accepts closing-delimiter transport spaces/tabs without modifying emitted original bytes. Reused or unsupported boundary forms are rejected conservatively. It is **not strict RFC conformance validation**: underlying libraries tolerate some malformed headers, charset byte sequences and noncanonical MIME. Replacement characters or undecoded encoded words can remain; supported-projection describes the bounded extraction policy, not proof that every original byte was well formed. Signed/encrypted attachments are preserved, not verified/decrypted.

HTML remains untrusted text. CID URLs and remote image links are preserved as text; there is no image data-URL expansion, URL fetching, sanitization or rendering. A later renderer must enforce its own HTML/resource policy.

## Evidence

`pnpm --dir apps/server exec bun test src/mail/mime/project.test.ts` strictly compiles and runs ten tests under actual Node. Synthetic cases cover German headers, quoted-printable/charset decoding, empty text, plain/HTML variants, inline images, embedded email, attached UTF-8 filenames, chunk-independent IDs, awaited 8 MiB generated attachment streaming, exact decoded hashes, malformed corpus, every budget, cancellation, hanging source/sink, sink early return, redaction and original immutability. `pnpm --dir apps/server typecheck` and `node apps/desktop/scripts/check-server-deps.mjs` validate integration types and runtime dependency mirroring. No real mail or provider request is used.
