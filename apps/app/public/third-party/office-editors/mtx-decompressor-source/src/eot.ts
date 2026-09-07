/**
 * EOT (Embedded OpenType) container parsing.
 *
 * Ported from libeot (MPL 2.0) — src/EOT.c. Parses the little-endian EOT
 * header that wraps MTX-compressed font data, derives where the font data
 * begins, and exposes the compression/encryption flags so callers no longer
 * have to guess them. `eotToTtf` chains this into {@link decompressEotFont} to
 * turn a raw `.eot` file straight into a TrueType binary.
 *
 * Note: every field in the EOT header is LITTLE-endian, unlike the big-endian
 * CTF/SFNT streams handled elsewhere in this library.
 *
 * @see http://www.w3.org/Submission/EOT/
 */

import { decompressEotFont } from './mtx-decompress';
import { EotError, EotErrorCode } from './errors';

// ---------------------------------------------------------------------------
// EOT header flags (flags.h)
// ---------------------------------------------------------------------------

/** The font is a subset of the original. */
export const TTEMBED_SUBSET = 0x00000001;
/** The font data is MTX-compressed. */
export const TTEMBED_TTCOMPRESSED = 0x00000004;
/** The font data is XOR-obfuscated with key 0x50. */
export const TTEMBED_XORENCRYPTDATA = 0x10000000;

/** Magic number appended after the code-page range fields (`"LP"` little-endian). */
const EOT_MAGIC = 0x504c;

/** fsType editing-permission mask (see {@link canLegallyEdit}). */
const EDITING_MASK = 0x0008;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** EOT header version. */
export type EotVersion = 1 | 2 | 3;

/** Parsed EOT container metadata. */
export interface EotMetadata {
	/** EOT header version (1, 2, or 3). */
	version: EotVersion;
	/** Raw `Flags` field (see the `TTEMBED_*` constants). */
	flags: number;
	/** 10-byte PANOSE classification. */
	panose: Uint8Array;
	/** `Charset` byte. */
	charset: number;
	/** Whether the font is italic. */
	italic: boolean;
	/** Weight (100–900). */
	weight: number;
	/** `fsType` embedding permissions (see {@link canLegallyEdit}). */
	permissions: number;
	/** The four `UnicodeRange` bitmask words. */
	unicodeRange: [number, number, number, number];
	/** The two `CodePageRange` bitmask words. */
	codePageRange: [number, number];
	/** `head.checkSumAdjustment` copied from the original font. */
	checkSumAdjustment: number;
	/** Font family name (decoded from UTF-16LE). */
	familyName: string;
	/** Subfamily / style name. */
	styleName: string;
	/** Version name string. */
	versionName: string;
	/** Full font name. */
	fullName: string;
	/** Root string (version 2+), else an empty string. */
	rootString: string;
	/** Declared total size of the EOT file, in bytes. */
	totalSize: number;
	/** Size of the embedded font data, in bytes. */
	fontDataSize: number;
	/** Absolute offset at which the font data begins. */
	fontDataOffset: number;
	/** True when the font data is MTX-compressed (`flags & TTEMBED_TTCOMPRESSED`). */
	compressed: boolean;
	/** True when the font data is XOR-encrypted (`flags & TTEMBED_XORENCRYPTDATA`). */
	encrypted: boolean;
	/**
	 * True when the version magic in the file disagreed with the version that
	 * actually parsed cleanly. The font is still usable (libeot returns
	 * `EOT_WARN_BAD_VERSION` in this case), but the header was inconsistent.
	 */
	badVersion: boolean;
}

// ---------------------------------------------------------------------------
// Little-endian primitive reads (bounds-checked)
// ---------------------------------------------------------------------------

function readU16LE(bytes: Uint8Array, at: number): number {
	return bytes[at] | (bytes[at + 1] << 8);
}

function readU32LE(bytes: Uint8Array, at: number): number {
	return (
		(bytes[at] |
			(bytes[at + 1] << 8) |
			(bytes[at + 2] << 16) |
			(bytes[at + 3] << 24)) >>>
		0
	);
}

/** Decode `count` UTF-16LE code units starting at `at` into a JS string. */
function decodeUtf16LE(bytes: Uint8Array, at: number, byteLength: number): string {
	let out = '';
	for (let i = 0; i < byteLength; i += 2) {
		out += String.fromCharCode(readU16LE(bytes, at + i));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Scanner — tracks an absolute cursor and enforces the body bound
// ---------------------------------------------------------------------------

/**
 * A forward cursor over the header body. `limit` is the absolute index one past
 * the last readable byte of the header (i.e. where the font data begins). The
 * bound uses `>` (reading N bytes needs `pos + N <= limit`); libeot's
 * `EOT_ENSURE_SCANNER` macro used `>=`, which is an off-by-one that spuriously
 * rejects the exact-fit case — the string/array helpers there already use the
 * correct `>`, so this matches libeot's intent.
 */
class Scanner {
	pos: number;
	constructor(
		private readonly bytes: Uint8Array,
		start: number,
		private readonly limit: number,
	) {
		this.pos = start;
	}

	private ensure(n: number): void {
		if (this.pos + n > this.limit) {
			throw new EotError(
				EotErrorCode.InsufficientBytes,
				`EOT header truncated: need ${n} more byte(s) at offset ${this.pos}`,
			);
		}
	}

	u16(): number {
		this.ensure(2);
		const v = readU16LE(this.bytes, this.pos);
		this.pos += 2;
		return v;
	}

	u32(): number {
		this.ensure(4);
		const v = readU32LE(this.bytes, this.pos);
		this.pos += 4;
		return v;
	}

	u8(): number {
		this.ensure(1);
		return this.bytes[this.pos++];
	}

	take(n: number): Uint8Array {
		this.ensure(n);
		const slice = this.bytes.subarray(this.pos, this.pos + n);
		this.pos += n;
		return slice;
	}

	skip(n: number): void {
		this.ensure(n);
		this.pos += n;
	}

	/** Read a length-prefixed (U16LE byte count) UTF-16LE string. */
	string(): string {
		this.ensure(2);
		const size = readU16LE(this.bytes, this.pos);
		this.pos += 2;
		if (size % 2 !== 0) {
			throw new EotError(
				EotErrorCode.BogusStringSize,
				`EOT string size ${size} is not a multiple of 2 (UTF-16)`,
			);
		}
		if (size === 0) {
			return '';
		}
		this.ensure(size);
		const s = decodeUtf16LE(this.bytes, this.pos, size);
		this.pos += size;
		return s;
	}

	/** Read a length-prefixed (U32LE byte count) raw byte array. */
	byteArray(): Uint8Array {
		this.ensure(4);
		const size = readU32LE(this.bytes, this.pos);
		this.pos += 4;
		if (size === 0) {
			return new Uint8Array(0);
		}
		return this.take(size);
	}
}

// ---------------------------------------------------------------------------
// Header body parsing (per version)
// ---------------------------------------------------------------------------

/** Sentinel thrown internally to drive the version-retry loop. */
class HeaderTooBig extends Error {}

/**
 * Parse the version-specific portion of the header. Mirrors
 * `EOTfillMetadataSpecifyingVersion`. Throws {@link HeaderTooBig} when the parse
 * consumed less than the declared header (a signal to try a higher version),
 * {@link EotError} with `InsufficientBytes` when it ran past the end (try lower),
 * and `CorruptFile` / `BogusStringSize` as terminal failures.
 */
function parseBody(
	bytes: Uint8Array,
	version: EotVersion,
	totalSize: number,
	fontDataSize: number,
): Omit<EotMetadata, 'compressed' | 'encrypted' | 'badVersion'> {
	const HEADER_START = 12;
	// The header body is bounded by where the font data must begin.
	const limit = bytes.length - fontDataSize;
	const sc = new Scanner(bytes, HEADER_START, limit);

	const flags = sc.u32();
	const panose = sc.take(10).slice();
	const charset = sc.u8();
	const italic = sc.u8() !== 0;
	const weight = sc.u32();
	const permissions = sc.u16();

	if (sc.u16() !== EOT_MAGIC) {
		throw new EotError(EotErrorCode.CorruptFile, 'EOT magic number (0x504C) mismatch');
	}

	const unicodeRange: [number, number, number, number] = [sc.u32(), sc.u32(), sc.u32(), sc.u32()];
	const codePageRange: [number, number] = [sc.u32(), sc.u32()];

	const checkSumAdjustment = sc.u32();
	// Skip Reserved1..4 (16 bytes) + Padding1 (2 bytes) after checkSumAdjustment.
	sc.skip(18);

	const familyName = sc.string();
	sc.skip(2); // Padding2
	const styleName = sc.string();
	sc.skip(2); // Padding3
	const versionName = sc.string();
	sc.skip(2); // Padding4
	const fullName = sc.string();

	let rootString = '';
	if (version > 1) {
		sc.skip(2); // Padding5
		rootString = sc.string();

		if (version === 3) {
			sc.u32(); // root string checksum (discarded)
			sc.u32(); // EUDC code page
			sc.skip(2); // Padding6
			const signatureSize = sc.u16();
			sc.skip(signatureSize); // signature (reserved)
			sc.u32(); // EUDC flags
			sc.byteArray(); // EUDC font data (unused here)
		}
	}

	const fontDataOffset = sc.pos;
	const expectedHeaderSize = totalSize - fontDataSize;
	if (fontDataOffset < expectedHeaderSize) {
		// We consumed less than the declared header — the real version is likely
		// higher. Signal the retry loop.
		throw new HeaderTooBig();
	}

	return {
		version,
		flags,
		panose,
		charset,
		italic,
		weight,
		permissions,
		unicodeRange,
		codePageRange,
		checkSumAdjustment,
		familyName,
		styleName,
		versionName,
		fullName,
		rootString,
		totalSize,
		fontDataSize,
		fontDataOffset,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const VERSION_MAGIC: Record<number, EotVersion> = {
	0x00010000: 1,
	0x00020001: 2,
	0x00020002: 3,
};

/**
 * Parse the metadata of an EOT container.
 *
 * Reproduces libeot's `EOTfillMetadata`, including the version-retry loop that
 * copes with EOT files whose declared version disagrees with their actual
 * layout. On a corrected version {@link EotMetadata.badVersion} is set rather
 * than throwing (libeot returns the recoverable `EOT_WARN_BAD_VERSION`).
 *
 * @param bytes Raw `.eot` file bytes.
 * @throws {EotError} on a corrupt or truncated container.
 */
export function parseEotMetadata(bytes: Uint8Array): EotMetadata {
	if (bytes.length < 8) {
		throw new EotError(EotErrorCode.InsufficientBytes, 'EOT file too small (need at least 8 bytes)');
	}

	const totalSize = readU32LE(bytes, 0);
	const fontDataSize = readU32LE(bytes, 4);
	// EOTgetMetadataLength = totalSize - fontDataSize; the file must be at least
	// that long to contain the full header.
	const metadataLength = totalSize - fontDataSize;
	if (bytes.length < metadataLength) {
		throw new EotError(
			EotErrorCode.InsufficientBytes,
			`EOT file shorter than its declared metadata length (${metadataLength})`,
		);
	}

	if (bytes.length < 12) {
		throw new EotError(EotErrorCode.InsufficientBytes, 'EOT file too small for a version field');
	}
	const versionMagic = readU32LE(bytes, 8);
	const codedVersion = VERSION_MAGIC[versionMagic];
	if (codedVersion === undefined) {
		throw new EotError(
			EotErrorCode.CorruptFile,
			`unrecognized EOT version magic 0x${versionMagic.toString(16)}`,
		);
	}

	// The font data must fit after the fixed 12-byte prologue.
	if (12 + fontDataSize > bytes.length) {
		throw new EotError(EotErrorCode.CorruptFile, 'EOT font data extends past end of file');
	}

	let tryVersion: EotVersion = codedVersion;
	let bumpedUp = false;
	let knockedDown = false;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			const body = parseBody(bytes, tryVersion, totalSize, fontDataSize);
			const flags = body.flags;
			return {
				...body,
				compressed: (flags & TTEMBED_TTCOMPRESSED) !== 0,
				encrypted: (flags & TTEMBED_XORENCRYPTDATA) !== 0,
				badVersion: tryVersion !== codedVersion,
			};
		} catch (err) {
			if (err instanceof HeaderTooBig) {
				// Under-read: try a higher version. The latches prevent oscillation.
				if (knockedDown || tryVersion === 3) {
					throw new EotError(EotErrorCode.CorruptFile, 'EOT header inconsistent across all versions');
				}
				knockedDown = false;
				bumpedUp = true;
				tryVersion = (tryVersion + 1) as EotVersion;
				continue;
			}
			if (err instanceof EotError && err.code === EotErrorCode.InsufficientBytes) {
				// Over-read: try a lower version.
				if (bumpedUp || tryVersion === 1) {
					throw new EotError(EotErrorCode.CorruptFile, 'EOT header inconsistent across all versions');
				}
				knockedDown = true;
				bumpedUp = false;
				tryVersion = (tryVersion - 1) as EotVersion;
				continue;
			}
			// CorruptFile / BogusStringSize and anything else are terminal.
			throw err;
		}
	}
}

/**
 * Decode a raw EOT container straight into a TrueType (.ttf) font binary.
 *
 * Parses the header, locates and slices the embedded font data, and runs it
 * through {@link decompressEotFont} using the container's own
 * compressed/encrypted flags. This is the drop-in equivalent of libeot's
 * `EOT2ttf_*` entry points.
 *
 * @param bytes Raw `.eot` file bytes.
 * @returns The reconstructed TrueType font.
 * @throws {EotError} on a corrupt container or during decompression.
 */
export function eotToTtf(bytes: Uint8Array): Uint8Array {
	const meta = parseEotMetadata(bytes);
	const fontData = bytes.subarray(meta.fontDataOffset, meta.fontDataOffset + meta.fontDataSize);
	return decompressEotFont(fontData, meta.compressed, meta.encrypted);
}

/**
 * Whether the font's embedding permissions allow editing.
 *
 * Mirrors libeot's `EOTcanLegallyEdit`. The upstream author asks that callers
 * reflect before circumventing this: installable-permission fonts (`fsType`
 * 0) and editable-embedding fonts may be edited; others may not.
 */
export function canLegallyEdit(metadata: EotMetadata): boolean {
	return metadata.permissions === 0 || (metadata.permissions & EDITING_MASK) !== 0;
}
