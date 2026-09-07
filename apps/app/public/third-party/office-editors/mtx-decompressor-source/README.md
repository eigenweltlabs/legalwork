# mtx-decompressor

[![npm version](https://img.shields.io/npm/v/mtx-decompressor.svg)](https://www.npmjs.com/package/mtx-decompressor)
[![CI](https://github.com/ChristopherVR/mtx-decompressor/actions/workflows/ci.yml/badge.svg)](https://github.com/ChristopherVR/mtx-decompressor/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/mtx-decompressor.svg)](LICENSE)

A zero-dependency TypeScript library that decompresses **MicroType Express (MTX)** compressed font data found inside **EOT** (Embedded OpenType) containers, producing standard **TrueType (.ttf)** font binaries.

MTX is a font compression format developed by Monotype, used inside EOT containers commonly found in older web pages and embedded in Microsoft Office documents. This library parses the EOT container, extracts the compressed data, and reconstructs a standard `.ttf` file usable with standard font APIs (e.g. the `FontFace` API). It has no dependencies and works in both the browser and Node.js.

<samp>**[▶️ Live demo](https://christophervr.github.io/mtx-decompressor/)** · **[📦 npm](https://www.npmjs.com/package/mtx-decompressor)**</samp>

---

## Demo

Try it right in your browser — drop in an `.eot` file, download the extracted `.ttf`, and preview text rendered in the decompressed font:

**https://christophervr.github.io/mtx-decompressor/**

## Install

```bash
npm install mtx-decompressor
```

## Quick start

The simplest path takes a whole `.eot` file and hands back a `.ttf`:

```typescript
import { eotToTtf } from 'mtx-decompressor';

const eotBytes: Uint8Array = /* the raw bytes of a .eot file */;
const ttfBytes = eotToTtf(eotBytes);
// => Uint8Array containing a valid TrueType font
```

`eotToTtf` parses the EOT header, locates the embedded font data, and applies
the container's own compression/encryption flags for you.

If you already have the MTX blob (or want the metadata), the lower-level API is
still available:

```typescript
import { parseEotMetadata, decompressMtx, decompressEotFont } from 'mtx-decompressor';

// Inspect the container and slice out the font data yourself
const meta = parseEotMetadata(eotBytes);
const fontData = eotBytes.subarray(meta.fontDataOffset, meta.fontDataOffset + meta.fontDataSize);
const ttf = decompressMtx(fontData, { compressed: meta.compressed, encrypted: meta.encrypted });

// Or, with an already-extracted blob and explicit flags:
const ttf2 = decompressEotFont(fontData, /* compressed */ true, /* encrypted */ false);

// XOR-obfuscated data
const decrypted = decompressMtx(encryptedData, { encrypted: true, compressed: true });
```

Errors are thrown as `EotError` with a machine-readable `code` (see
`EotErrorCode`) so corrupt vs. truncated vs. unsupported inputs can be told
apart.

## API

### `eotToTtf(eotBytes)`

Parse a raw EOT container and return the reconstructed TrueType binary. Handles
header parsing, font-data extraction, and the container's compression/encryption
flags. Throws `EotError` on a corrupt or truncated container.

### `parseEotMetadata(eotBytes)`

Parse just the EOT header. Returns an `EotMetadata` object: `version`, `flags`,
`compressed`, `encrypted`, `familyName` / `styleName` / `versionName` /
`fullName`, `fontDataOffset`, `fontDataSize`, `permissions`, and more. Includes
libeot's version-retry logic for files whose declared version disagrees with
their layout (`metadata.badVersion` is set rather than throwing). Throws
`EotError` on corrupt input.

### `canLegallyEdit(metadata)`

Given an `EotMetadata`, returns whether the font's `fsType` embedding
permissions allow editing.

### `decompressMtx(fontData, options?)`

Decompress an MTX-compressed font into a TrueType binary.

| Parameter            | Type                         | Description                                                                   |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `fontData`           | `Uint8Array`                 | Raw font bytes (MTX-compressed, optionally encrypted)                         |
| `options.encrypted`  | `boolean` (default: `false`) | If `true`, XOR-decrypt with key `0x50` before decompression                   |
| `options.compressed` | `boolean` (default: `true`)  | If `false`, skip decompression and return the (possibly decrypted) data as-is |
| `options.onWarn`     | `(message: string) => void`  | Optional hook called for each non-fatal diagnostic (e.g. a dropped `hdmx`/`VDMX` table); the font is still produced |
| **Returns**          | `Uint8Array`                 | A valid TrueType (.ttf) font binary                                           |

### `decompressEotFont(fontData, compressed, encrypted)`

Convenience wrapper around `decompressMtx` taking explicit boolean parameters; returns a TrueType binary.

### `unpackMtx(data, size)`

Low-level: unpack an MTX blob into three LZCOMP-decompressed streams. Returns `{ streams: Uint8Array[], sizes: number[] }`.

The exported `SFNTContainer` and `SFNTTable` types describe the reconstructed font tables. `EotError` / `EotErrorCode` provide machine-discriminable error handling.

## How it works

The pipeline: EOT container parsing (little-endian header → font-data offset + flags) → optional XOR decryption → MTX header parsing (splits into three LZCOMP blocks) → LZCOMP decompression (sliding-window LZ with adaptive Huffman coding) → CTF parsing (reconstructs TrueType tables from the three Compact TrueType Font streams) → SFNT assembly (table directory, alignment, checksums).

## Provenance

A TypeScript port of the MTX decompression code from [libeot](https://github.com/umanwizard/libeot) by Brennan Vincent (MPL-2.0). The original C implementation is based on the [MicroType Express specification](http://www.w3.org/Submission/MTX/) submitted to the W3C by Monotype Imaging.

## License

[MPL-2.0](LICENSE). As a TypeScript port of the MPL-2.0-licensed libeot, this library inherits the Mozilla Public License 2.0 — modifications to the licensed files must remain open under the same terms.
