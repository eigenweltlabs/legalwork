/**
 * Top-level MicroType Express (MTX) decompression pipeline.
 * Ported from libeot (MPL 2.0) — writeFontFile.c / liblzcomp.c
 *
 * Combines LZ decompression, CTF parsing, and SFNT assembly to
 * produce a usable TrueType font from compressed MTX / EOT data.
 */

import { parseCTF } from './ctf-parser';
import { lzcompDecompress } from './lzcomp';
import { dumpContainer } from './sfnt-builder';
import { Stream } from './stream';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** XOR key used for MTX encryption. */
const ENCRYPTION_KEY = 0x50;

// ---------------------------------------------------------------------------
// MTX unpacking (3-stream decompression)
// ---------------------------------------------------------------------------

/**
 * Unpack an MTX blob into three LZCOMP-decompressed streams.
 *
 * MTX header layout (10 bytes, big-endian):
 *   byte  0     : versionMagic
 *   bytes 1–3   : copyLimit  (24-bit BE, informational only)
 *   bytes 4–6   : offset2    (24-bit BE)
 *   bytes 7–9   : offset3    (24-bit BE)
 *
 * The data following the header is split into three contiguous
 * compressed blocks whose boundaries are determined by the offsets.
 *
 * @param data  Raw MTX data (BSGP header must already be stripped and
 *              offsets adjusted before calling this function).
 * @param size  Total byte length of `data`.
 * @returns An object containing the three decompressed byte arrays and
 *          their respective sizes.
 */
export function unpackMtx(
	data: Uint8Array,
	size: number,
): { streams: Uint8Array[]; sizes: number[] } {
	// --- Validate buffer & header ------------------------------------------
	if (size < 10 || data.length < 10) {
		throw new Error('MTX data too small: header requires at least 10 bytes');
	}

	// --- Read 10-byte MTX header -------------------------------------------
	const versionMagic = data[0];

	// 24-bit big-endian reads
	// const copyLimit = (data[1] << 16) | (data[2] << 8) | data[3]; // not used
	const offset2 = (data[4] << 16) | (data[5] << 8) | data[6];
	const offset3 = (data[7] << 16) | (data[8] << 8) | data[9];

	// Validate offset ordering: 10 <= offset2 <= offset3 <= size
	if (offset2 < 10 || offset3 < offset2 || offset3 > size) {
		throw new Error(
			`MTX header offsets out of bounds: offset2=${offset2}, offset3=${offset3}, size=${size}`,
		);
	}

	// Block boundaries — clamp blockSizes to >= 0 defensively
	const offsets = [10, offset2, offset3];
	const blockSizes = [
		Math.max(0, offset2 - 10),
		Math.max(0, offset3 - offset2),
		Math.max(0, size - offset3),
	];

	// Decompress each block
	const streams: Uint8Array[] = [];
	const decompressedSizes: number[] = [];

	for (let i = 0; i < 3; i++) {
		const block = data.subarray(offsets[i]);
		const decompressed = lzcompDecompress(block, blockSizes[i], versionMagic);
		streams.push(decompressed);
		decompressedSizes.push(decompressed.length);
	}

	return { streams, sizes: decompressedSizes };
}

// ---------------------------------------------------------------------------
// Main decompression entry point
// ---------------------------------------------------------------------------

/**
 * Decompress an MTX-compressed font (e.g. from an EOT wrapper) into a
 * standard TrueType font binary.
 *
 * @param fontData    Raw font bytes (MTX-compressed, optionally encrypted).
 * @param options.encrypted   If `true`, XOR-decrypt with {@link ENCRYPTION_KEY}.
 * @param options.compressed  If `false`, skip decompression and return the
 *                            (possibly decrypted) data as-is.
 * @param options.onWarn      Optional hook invoked with a message for each
 *                            non-fatal diagnostic (e.g. a dropped hdmx/VDMX
 *                            table). The font is still produced.
 * @returns A `Uint8Array` containing a valid TrueType (.ttf) font.
 */
export function decompressMtx(
	fontData: Uint8Array,
	options?: { encrypted?: boolean; compressed?: boolean; onWarn?: (message: string) => void },
): Uint8Array {
	const encrypted = options?.encrypted ?? false;
	const compressed = options?.compressed ?? true;

	// --- Decryption --------------------------------------------------------
	let data: Uint8Array;
	if (encrypted) {
		data = new Uint8Array(fontData.length);
		for (let i = 0; i < fontData.length; i++) {
			data[i] = fontData[i] ^ ENCRYPTION_KEY;
		}
	} else {
		// Alias the caller's buffer — the decompression path only reads from it,
		// never writes. (On the uncompressed passthrough below we hand back an
		// owned copy so the caller's array is never returned as our output.)
		data = fontData;
	}

	// --- Early exit when not compressed ------------------------------------
	if (!compressed) {
		// Return an owned buffer, matching libeot (writeFontFile.c always copies).
		// The encrypted branch already allocated a fresh array; the aliased
		// branch must be copied so we never return the caller's own buffer.
		return encrypted ? data : data.slice();
	}

	// --- Unpack 3 LZCOMP streams ------------------------------------------
	const { streams } = unpackMtx(data, data.length);

	// --- Wrap each decompressed buffer in a Stream -------------------------
	const streamObjects = streams.map((buf) => new Stream(buf, buf.length));

	// --- Parse CTF structure -----------------------------------------------
	const container = parseCTF(streamObjects, { onWarn: options?.onWarn });

	// --- Assemble final TrueType font -------------------------------------
	return dumpContainer(container);
}

// ---------------------------------------------------------------------------
// Convenience wrapper (explicit boolean parameters)
// ---------------------------------------------------------------------------

/**
 * Decompress an EOT-embedded font.
 *
 * This is a thin wrapper around {@link decompressMtx} that accepts explicit
 * boolean parameters instead of an options object.
 *
 * @param fontData    Raw font bytes extracted from the EOT container.
 * @param compressed  Whether the data is MTX-compressed.
 * @param encrypted   Whether the data is XOR-encrypted.
 * @returns A `Uint8Array` containing a valid TrueType (.ttf) font.
 */
export function decompressEotFont(
	fontData: Uint8Array,
	compressed: boolean,
	encrypted: boolean,
): Uint8Array {
	return decompressMtx(fontData, { encrypted, compressed });
}
