/**
 * CTF (Compact TrueType Font) parser — reconstructs a TrueType font from
 * three decompressed CTF streams produced by LZCOMP decompression.
 *
 * Ported from libeot (MPL 2.0) — parseCTF.c
 *
 * @see http://www.w3.org/Submission/MTX/
 */

import { EotError, EotErrorCode } from './errors';
import { Stream } from './stream';
import { TRIPLET_ENCODINGS } from './triplet-encodings';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A single SFNT table record. */
export interface SFNTTable {
	/** 4-character tag (e.g. "head", "maxp", "glyf", "loca"). */
	tag: string;
	/** Offset into the original CTF stream (or final offset in the output). */
	offset: number;
	/** Size of the table data in bytes. */
	bufSize: number;
	/** Raw table data. */
	buf: Uint8Array;
	/** Table checksum. */
	checksum: number;
}

/** Collection of SFNT tables that constitute a font. */
export interface SFNTContainer {
	tables: SFNTTable[];
	/**
	 * Tags of tables the parser dropped rather than reconstructing (currently
	 * `hdmx` / `VDMX`, which MTX does not round-trip). Present for diagnostics;
	 * mirrors the warning libeot logs when it skips these tables.
	 */
	droppedTables?: string[];
}

/** Optional hooks for {@link parseCTF}. */
export interface ParseCTFOptions {
	/**
	 * Invoked once per non-fatal diagnostic (e.g. a dropped hdmx/VDMX table).
	 * Lets callers surface warnings without the library writing to `console`.
	 */
	onWarn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants — TrueType glyph flag bits
// ---------------------------------------------------------------------------

const FLG_ON_CURVE = 0x01;
const FLG_X_SHORT = 0x02;
const FLG_Y_SHORT = 0x04;
const FLG_X_SAME = 0x10;
const FLG_Y_SAME = 0x20;

// ---------------------------------------------------------------------------
// Constants — TrueType PUSH instructions
// ---------------------------------------------------------------------------

const NPUSHB = 0x40;
const NPUSHW = 0x41;
const PUSHB = 0xb0;
const PUSHW = 0xb8;

// ---------------------------------------------------------------------------
// Constants — composite glyph flags
// ---------------------------------------------------------------------------

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const HAVE_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const HAVE_XY_SCALE = 0x0040;
const HAVE_2_BY_2 = 0x0080;
const HAVE_INSTRUCTIONS = 0x0100;

// ---------------------------------------------------------------------------
// INT16 helpers
// ---------------------------------------------------------------------------

const INT16_MIN = -32768;
const INT16_MAX = 32767;

/** Wrap a value into signed 16-bit range. */
function toInt16(v: number): number {
	v &= 0xffff;
	return v >= 0x8000 ? v - 0x10000 : v;
}

// ---------------------------------------------------------------------------
// read255UShort — MTX 255UShort variable-length unsigned integer encoding
// ---------------------------------------------------------------------------

/**
 * Read a 255UShort value from the stream.
 *
 * Encoding:
 *  - 253: next two bytes form a big-endian U16
 *  - 255: 253 + next U8
 *  - 254: 506 + next U8
 *  - else: literal value
 */
function read255UShort(s: Stream): number {
	const code = s.readU8();
	if (code === 253) {
		return s.readU16();
	}
	if (code === 255) {
		return 253 + s.readU8();
	}
	if (code === 254) {
		return 506 + s.readU8();
	}
	return code;
}

// ---------------------------------------------------------------------------
// read255Short — MTX 255Short variable-length signed integer encoding
// ---------------------------------------------------------------------------

/**
 * Read a 255Short value from the stream.
 *
 * Encoding:
 *  - 253: next two bytes form a big-endian S16
 *  - 250: negate sign, then re-read next code
 *  - 255: 250 + next U8
 *  - 254: 500 + next U8
 *  - else: literal value
 *
 * The final result is multiplied by the accumulated sign.
 */
function read255Short(s: Stream): number {
	let sign = 1;
	let code = s.readU8();

	if (code === 253) {
		return s.readS16();
	}

	// 250 negates the sign and reads the next code byte
	if (code === 250) {
		sign = -1;
		code = s.readU8();
	}

	let value: number;
	if (code === 255) {
		value = 250 + s.readU8();
	} else if (code === 254) {
		value = 500 + s.readU8();
	} else {
		value = code;
	}
	return value * sign;
}

// ---------------------------------------------------------------------------
// unpackCVT — delta-decode the Control Value Table
// ---------------------------------------------------------------------------

/**
 * Decode a delta-encoded CVT (Control Value Table).
 *
 * Each entry is a signed delta added to a running accumulator and written
 * as a big-endian S16 into the output buffer.
 */
function unpackCVT(table: SFNTTable, sIn: Stream): void {
	sIn.seekAbsolute(table.offset);

	// First U16 is the number of CVT entries (each decodes to one 2-byte S16),
	// per the MTX spec §5.2 ("USHORT numEntries — Number of cvt entries") and
	// libeot's unpackCVT, which reserves numEntries * sizeof(int16_t) bytes.
	const numEntries = sIn.readU16();

	const out = new Stream(null, 0);
	out.reserve(numEntries * 2);

	let lastValue = 0;

	for (let i = 0; i < numEntries; i++) {
		const code = sIn.readU8();
		let val: number;

		if (code >= 248) {
			// Positive multi-byte: val = 238 * (code - 247) + nextByte
			val = 238 * (code - 247) + sIn.readU8();
		} else if (code >= 239) {
			// Negative multi-byte: val = -(238 * (code - 239) + nextByte)
			val = -(238 * (code - 239) + sIn.readU8());
		} else if (code === 238) {
			// Full signed 16-bit value
			val = sIn.readS16();
		} else {
			// Literal small value
			val = code;
		}

		lastValue = toInt16(lastValue + val);
		out.writeS16(lastValue);
	}

	table.buf = out.toUint8Array();
	table.bufSize = table.buf.length;
}

// ---------------------------------------------------------------------------
// decodePushInstructions — decode hop-coded push data
// ---------------------------------------------------------------------------

/**
 * Decode hop-coded push data from the instruction stream and emit standard
 * TrueType PUSH instructions to the output stream.
 *
 * Hop codes allow compact representation of alternating patterns:
 *  - 0xFB (hop3): `A B → A B A C A`   (consumes 3 more from remaining)
 *  - 0xFC (hop4): `A B → A B A C A D A` (consumes 5 more from remaining)
 *  - default: read 255Short, consumes 1 from remaining
 *
 * Values are flushed with the appropriate PUSH opcode when the type changes
 * (BYTE vs SHORT) or the accumulated count reaches 255.
 */
function decodePushInstructions(sIn: Stream, sOut: Stream, pushCount: number): void {
	if (pushCount === 0) {
		return;
	}

	// Accumulator for decoded push values (matches C: data[] array)
	const data: number[] = [];
	let remaining = pushCount;

	// Current run state for flushing PUSHB/PUSHW instructions
	let isShort = false;
	const runValues: number[] = [];

	/** Flush accumulated run values with the appropriate PUSH opcode. */
	function flush(): void {
		if (runValues.length === 0) {
			return;
		}
		const count = runValues.length;
		if (isShort) {
			if (count < 8) {
				sOut.writeU8(PUSHW + (count - 1));
			} else {
				sOut.writeU8(NPUSHW);
				sOut.writeU8(count);
			}
			for (const v of runValues) {
				sOut.writeS16(v);
			}
		} else {
			if (count < 8) {
				sOut.writeU8(PUSHB + (count - 1));
			} else {
				sOut.writeU8(NPUSHB);
				sOut.writeU8(count);
			}
			for (const v of runValues) {
				sOut.writeU8(v & 0xff);
			}
		}
		runValues.length = 0;
	}

	/** Add a single value to the run, flushing on type change or overflow. */
	function put(v: number): void {
		data.push(v);
		const needsShort = v < 0 || v > 255;
		if (runValues.length > 0 && needsShort !== isShort) {
			flush();
		}
		if (runValues.length === 0) {
			isShort = needsShort;
		}
		runValues.push(v);
		if (runValues.length >= 255) {
			flush();
		}
	}

	while (remaining > 0) {
		// Peek at next byte to check for hop codes
		const code = sIn.peekU8();

		if (code === 0xfb) {
			// hop3: A B 0xFB C → A B A C A
			// A is data[dataIndex - 2] (the value 2 back in decoded output).
			// 0xFB is unambiguously a hop marker here; if the surrounding data
			// can't satisfy the expansion the stream is corrupt (libeot returns
			// EOT_CORRUPT_HOPCODE_DATA rather than treating 0xFB as a literal).
			if (remaining < 3 || data.length < 2) {
				throw new EotError(
					EotErrorCode.CorruptHopcodeData,
					`corrupt hop3 (0xFB) push data: remaining=${remaining}, decoded=${data.length}`,
				);
			}
			sIn.readU8(); // consume the 0xFB
			const prev = data[data.length - 2];
			put(prev);
			const val = read255Short(sIn);
			put(val);
			put(prev);
			remaining -= 3;
		} else if (code === 0xfc) {
			// hop4: A B 0xFC C D → A B A C A D A
			if (remaining < 5 || data.length < 2) {
				throw new EotError(
					EotErrorCode.CorruptHopcodeData,
					`corrupt hop4 (0xFC) push data: remaining=${remaining}, decoded=${data.length}`,
				);
			}
			sIn.readU8(); // consume the 0xFC
			const prev = data[data.length - 2];
			put(prev);
			const c = read255Short(sIn);
			put(c);
			put(prev);
			const d = read255Short(sIn);
			put(d);
			put(prev);
			remaining -= 5;
		} else {
			// Default: read one value via read255Short
			const v = read255Short(sIn);
			put(v);
			remaining -= 1;
		}
	}

	flush();
}

// ---------------------------------------------------------------------------
// makeGlyphFlags — create a TrueType simple-glyph flag byte
// ---------------------------------------------------------------------------

/**
 * Build the TrueType flag byte for a single point.
 *
 * @param x         X coordinate delta.
 * @param y         Y coordinate delta.
 * @param onCurve   Whether the point is on the curve.
 * @param firstTime Whether this is the very first point in the glyph (always
 *                  write the coordinate even if it is zero).
 */
function makeGlyphFlags(x: number, y: number, onCurve: boolean, firstTime: boolean): number {
	let flags = 0;

	if (onCurve) {
		flags |= FLG_ON_CURVE;
	}

	// --- X axis ---
	if (!firstTime && x === 0) {
		// Repeat previous value (X_SAME means "same as last" when X_SHORT is 0)
		flags |= FLG_X_SAME;
	} else if (x > -256 && x < 0) {
		flags |= FLG_X_SHORT;
	} else if (x >= 0 && x < 256) {
		flags |= FLG_X_SHORT | FLG_X_SAME;
	}

	// --- Y axis ---
	if (!firstTime && y === 0) {
		flags |= FLG_Y_SAME;
	} else if (y > -256 && y < 0) {
		flags |= FLG_Y_SHORT;
	} else if (y >= 0 && y < 256) {
		flags |= FLG_Y_SHORT | FLG_Y_SAME;
	}

	return flags;
}

// ---------------------------------------------------------------------------
// decodeSimpleGlyph — reconstruct a simple (non-composite) glyph
// ---------------------------------------------------------------------------

/**
 * Decode a simple glyph from the three CTF streams and write standard
 * TrueType glyph data to `out`.
 *
 * @param numContours  Number of contours (positive).
 * @param streams      The three CTF streams:
 *                       [0] = glyph / coordinate data,
 *                       [1] = push instruction data,
 *                       [2] = hinting code data.
 * @param out          Output stream receiving TrueType glyph bytes.
 * @param calcBBox     If true, compute the bounding box from point data.
 * @param minX/minY/maxX/maxY  Explicit bbox values used when calcBBox=false.
 */
function decodeSimpleGlyph(
	numContours: number,
	streams: Stream[],
	out: Stream,
	calcBBox: boolean,
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): void {
	// C reference: numContours == 0 means an empty glyph (e.g. .notdef,
	// unused code points).  Return immediately without reading from streams
	// or writing to output.  Missing this guard causes the decoder to read
	// pushCount/codeSize from stream 0 for every empty glyph, accumulating
	// extra byte consumption that exhausts the stream.
	if (numContours === 0) {
		return;
	}

	const sGlyph = streams[0];

	// --- Write numberOfContours (S16) --------------------------------------
	out.writeS16(numContours);

	// --- Bounding box placeholder or explicit values -----------------------
	const bboxPos = out.pos;
	if (calcBBox) {
		// Reserve 4 × S16 for the bbox; we'll fill it in later
		minX = INT16_MAX;
		minY = INT16_MAX;
		maxX = INT16_MIN;
		maxY = INT16_MIN;
		out.writeS16(0); // xMin placeholder
		out.writeS16(0); // yMin placeholder
		out.writeS16(0); // xMax placeholder
		out.writeS16(0); // yMax placeholder
	} else {
		out.writeS16(minX);
		out.writeS16(minY);
		out.writeS16(maxX);
		out.writeS16(maxY);
	}

	// --- endPtsOfContours --------------------------------------------------
	// C reference starts totalPoints at 1 for the first contour, then
	// adds pointsInContour for each.  This extra point is part of the
	// CTF format and is included in the flag/coordinate data in the stream.
	let totalPoints = 0;
	for (let c = 0; c < numContours; c++) {
		if (c === 0) {
			totalPoints = 1;
		}
		const pointsInContour = read255UShort(sGlyph);
		totalPoints += pointsInContour;
		out.writeU16(totalPoints - 1);
	}

	// --- Read per-point flag bytes from the glyph stream -------------------
	// Per the W3C MTX spec and the libeot reference (parseCTF.c), flags
	// are read in a first pass, then coordinate data in a second pass.
	const flagBytes = new Uint8Array(totalPoints);
	for (let i = 0; i < totalPoints; i++) {
		flagBytes[i] = sGlyph.readU8();
	}

	// --- Decode coordinate deltas using triplet encodings ------------------
	const xDeltas = new Int16Array(totalPoints);
	const yDeltas = new Int16Array(totalPoints);
	const onCurve = new Uint8Array(totalPoints);

	let cumulativeX = 0;
	let cumulativeY = 0;

	for (let i = 0; i < totalPoints; i++) {
		const flag = flagBytes[i];
		onCurve[i] = flag & 0x80 ? 0 : 1; // C reference: !(flags[i] & 0x80)

		const enc = TRIPLET_ENCODINGS[flag & 0x7f];

		// Read raw X and Y bit-fields directly from the glyph stream.
		// `xBits + yBits == 8 * (byteCount - 1)` for every triplet entry, so
		// the stream remains byte-aligned after both reads — no temporary
		// allocation needed (was: per-point Uint8Array + Stream, perf hot path).
		let dx = sGlyph.readNBits(enc.xBits) + enc.deltaX;
		let dy = sGlyph.readNBits(enc.yBits) + enc.deltaY;

		// Apply sign
		if (enc.xSign !== 0) {
			dx *= enc.xSign;
		}
		if (enc.ySign !== 0) {
			dy *= enc.ySign;
		}

		xDeltas[i] = dx;
		yDeltas[i] = dy;

		// Accumulate for bbox calculation using the int16-truncated deltas
		// (`xDeltas`/`yDeltas` are Int16Array). This matches libeot, which
		// narrows each delta to int16_t before folding it into the running
		// bbox — and is the value the glyph actually renders with, since the
		// written coordinates come from the same truncated deltas. Differs from
		// the raw delta only for the 16-bit triplet encodings with a delta that
		// overflows int16, which no valid encoder emits.
		cumulativeX += xDeltas[i];
		cumulativeY += yDeltas[i];

		if (calcBBox) {
			if (cumulativeX < minX) {
				minX = cumulativeX;
			}
			if (cumulativeX > maxX) {
				maxX = cumulativeX;
			}
			if (cumulativeY < minY) {
				minY = cumulativeY;
			}
			if (cumulativeY > maxY) {
				maxY = cumulativeY;
			}
		}
	}

	// --- Hinting instructions ----------------------------------------------
	// Reserve space to write instructionLength (U16) later
	const codeSizeLocation = out.pos;
	out.writeU16(0); // placeholder

	// Decode push instructions from stream[1]
	const pushCount = read255UShort(sGlyph);
	decodePushInstructions(streams[1], out, pushCount);

	// Copy raw hinting code from stream[2]
	const codeSize = read255UShort(sGlyph);
	if (codeSize > 0) {
		streams[2].copyTo(out, codeSize);
	}

	// Compute the total instruction byte size and write it back
	const unpackedCodeSize = out.pos - (codeSizeLocation + 2);
	const savedPos = out.pos;
	out.seekAbsolute(codeSizeLocation);
	out.writeU16(unpackedCodeSize);
	out.seekAbsolute(savedPos);

	// --- Write TrueType flag bytes -----------------------------------------
	for (let i = 0; i < totalPoints; i++) {
		const f = makeGlyphFlags(xDeltas[i], yDeltas[i], onCurve[i] !== 0, i === 0);
		out.writeU8(f);
	}

	// --- Write X coordinates -----------------------------------------------
	for (let i = 0; i < totalPoints; i++) {
		const x = xDeltas[i];
		if (i === 0 || x !== 0) {
			const absX = Math.abs(x);
			if (absX < 256) {
				out.writeU8(absX);
			} else {
				out.writeS16(x);
			}
		}
	}

	// --- Write Y coordinates -----------------------------------------------
	for (let i = 0; i < totalPoints; i++) {
		const y = yDeltas[i];
		if (i === 0 || y !== 0) {
			const absY = Math.abs(y);
			if (absY < 256) {
				out.writeU8(absY);
			} else {
				out.writeS16(y);
			}
		}
	}

	// --- Write bbox if it was computed -------------------------------------
	if (calcBBox) {
		const endPos = out.pos;
		out.seekAbsolute(bboxPos);
		out.writeS16(minX);
		out.writeS16(minY);
		out.writeS16(maxX);
		out.writeS16(maxY);
		out.seekAbsolute(endPos);
	}
}

// ---------------------------------------------------------------------------
// decodeCompositeGlyph — reconstruct a composite (compound) glyph
// ---------------------------------------------------------------------------

/**
 * Decode a composite glyph from the CTF streams.
 *
 * Composite glyphs reference other glyphs via component records. Each
 * component specifies a glyph index, positioning arguments, and optional
 * transformation matrices.
 */
function decodeCompositeGlyph(streams: Stream[], out: Stream): void {
	const sGlyph = streams[0];

	// numberOfContours = -1 for composite glyphs
	out.writeS16(-1);

	// Copy bounding box (4 × S16) directly from the glyph stream
	out.writeS16(sGlyph.readS16()); // xMin
	out.writeS16(sGlyph.readS16()); // yMin
	out.writeS16(sGlyph.readS16()); // xMax
	out.writeS16(sGlyph.readS16()); // yMax

	// --- Component records -------------------------------------------------
	let flags = 0;
	do {
		flags = sGlyph.readU16();
		const glyphIndex = sGlyph.readU16();

		out.writeU16(flags);
		out.writeU16(glyphIndex);

		// Determine the number of argument bytes
		let argBytes: number;
		if (flags & ARG_1_AND_2_ARE_WORDS) {
			argBytes = 4; // two S16 values
		} else {
			argBytes = 2; // two S8 values packed into 2 bytes
		}
		sGlyph.copyTo(out, argBytes);

		// Determine the number of transformation bytes
		let transformBytes = 0;
		if (flags & HAVE_2_BY_2) {
			transformBytes = 8; // four F2Dot14 values
		} else if (flags & HAVE_XY_SCALE) {
			transformBytes = 4; // two F2Dot14 values
		} else if (flags & HAVE_SCALE) {
			transformBytes = 2; // one F2Dot14 value
		}
		if (transformBytes > 0) {
			sGlyph.copyTo(out, transformBytes);
		}
	} while (flags & MORE_COMPONENTS);

	// --- Component instructions --------------------------------------------
	if (flags & HAVE_INSTRUCTIONS) {
		// Reserve space for numInstr (U16)
		const numInstrPos = out.pos;
		out.writeU16(0); // placeholder

		// Decode push instructions from stream[1]
		const pushCount = read255UShort(sGlyph);
		decodePushInstructions(streams[1], out, pushCount);

		// Copy raw hinting code from stream[2]
		const codeSize = read255UShort(sGlyph);
		if (codeSize > 0) {
			streams[2].copyTo(out, codeSize);
		}

		// Write back actual instruction size
		const numInstr = out.pos - (numInstrPos + 2);
		const savedPos = out.pos;
		out.seekAbsolute(numInstrPos);
		out.writeU16(numInstr);
		out.seekAbsolute(savedPos);
	}
}

// ---------------------------------------------------------------------------
// decodeGlyph — dispatch to simple or composite glyph decoder
// ---------------------------------------------------------------------------

/**
 * Decode a single glyph from the CTF streams.
 *
 * The first value read is `numContours`:
 *  - Negative: composite glyph
 *  - 0x7FFF:  simple glyph with explicit bbox and actual contour count
 *  - Other:   simple glyph with computed bbox
 */
function decodeGlyph(streams: Stream[], out: Stream): void {
	const numContours = streams[0].readS16();

	if (numContours < 0) {
		// Composite glyph
		decodeCompositeGlyph(streams, out);
	} else if (numContours === 0x7fff) {
		// Simple glyph with explicit bbox — read actual contour count and bbox
		const actualContours = streams[0].readS16();
		const xMin = streams[0].readS16();
		const yMin = streams[0].readS16();
		const xMax = streams[0].readS16();
		const yMax = streams[0].readS16();
		decodeSimpleGlyph(actualContours, streams, out, false, xMin, yMin, xMax, yMax);
	} else {
		// Simple glyph — compute bbox from point data
		decodeSimpleGlyph(numContours, streams, out, true, 0, 0, 0, 0);
	}
}

// ---------------------------------------------------------------------------
// populateGlyfAndLoca — decode all glyphs and build the loca index
// ---------------------------------------------------------------------------

/**
 * Iterate over every glyph, decode it, and build the `glyf` and `loca`
 * tables.
 *
 * @param glyf      The glyf table descriptor (output buf/bufSize are set).
 * @param loca      The loca table descriptor (output buf/bufSize are set).
 * @param headData  Parsed `head` table fields.
 * @param maxpData  Parsed `maxp` table fields.
 * @param streams   The three CTF streams.
 */
function populateGlyfAndLoca(
	glyf: SFNTTable,
	loca: SFNTTable,
	headData: { indexToLocFormat: number },
	maxpData: {
		numGlyphs: number;
		maxPoints: number;
		maxContours: number;
		maxSizeOfInstructions: number;
		maxComponentElements: number;
	},
	streams: Stream[],
): void {
	const numGlyphs = maxpData.numGlyphs;

	// Seek the glyph stream to the glyf table's offset
	streams[0].seekAbsolute(glyf.offset);

	// Reset push-instruction and hinting-code streams to the beginning
	streams[1].seekAbsolute(0);
	streams[2].seekAbsolute(0);

	// Estimate max glyph output size: generous upper bound
	const maxGlyphSize =
		5 * 2 + // header (numContours + bbox)
		2 * maxpData.maxContours + // endPtsOfContours
		2 + // instructionLength
		maxpData.maxSizeOfInstructions +
		256 + // instructions + padding
		5 * maxpData.maxPoints + // flags + coordinates
		4 * maxpData.maxComponentElements * 6 + // composite components
		256; // safety margin

	const outStream = new Stream(null, 0);
	outStream.reserve(numGlyphs * 256); // rough initial reservation

	// Short loca format: (numGlyphs + 1) × U16; Long format: (numGlyphs + 1) × U32
	const isShortLoca = headData.indexToLocFormat === 0;
	const locaEntrySize = isShortLoca ? 2 : 4;
	const locaStream = new Stream(null, 0);
	locaStream.reserve((numGlyphs + 1) * locaEntrySize);

	// Write initial loca entry (offset 0)
	if (isShortLoca) {
		locaStream.writeU16(0);
	} else {
		locaStream.writeU32(0);
	}

	for (let i = 0; i < numGlyphs; i++) {
		const _glyphStart = outStream.pos;

		// Ensure enough room for the worst-case glyph
		outStream.reserve(outStream.pos + maxGlyphSize);

		decodeGlyph(streams, outStream);

		// Pad to 2-byte boundary (TrueType requires even-aligned glyph data)
		if (outStream.pos & 1) {
			outStream.writeU8(0);
		}

		// Write loca entry for the *end* of this glyph (= start of next)
		if (isShortLoca) {
			// Short format stores offset / 2
			locaStream.writeU16(outStream.pos >>> 1);
		} else {
			locaStream.writeU32(outStream.pos);
		}
	}

	// Store results
	glyf.buf = outStream.toUint8Array();
	glyf.bufSize = glyf.buf.length;

	loca.buf = locaStream.toUint8Array();
	loca.bufSize = loca.buf.length;
}

// ---------------------------------------------------------------------------
// TTF table parsing helpers
// ---------------------------------------------------------------------------

/** Parsed fields from the `head` table. */
interface HeadData {
	indexToLocFormat: number;
}

/**
 * Parse the `head` table to extract `indexToLocFormat`.
 *
 * `indexToLocFormat` is at byte offset 50 within the `head` table.
 */
function parseHead(table: SFNTTable): HeadData {
	const s = new Stream(table.buf, table.bufSize);
	s.seekAbsolute(50);
	return { indexToLocFormat: s.readS16() };
}

/** Parsed fields from the `maxp` table. */
interface MaxpData {
	numGlyphs: number;
	maxPoints: number;
	maxContours: number;
	maxSizeOfInstructions: number;
	maxComponentElements: number;
}

/**
 * Parse the `maxp` table to extract key metrics.
 *
 * Version 1.0 (0x00010000) layout:
 *   offset 0  : version          U32
 *   offset 4  : numGlyphs        U16
 *   offset 6  : maxPoints         U16
 *   offset 8  : maxContours       U16
 *   offset 10 : maxCompositePoints U16
 *   offset 12 : maxCompositeContours U16
 *   offset 14 : maxZones          U16
 *   offset 16 : maxTwilightPoints U16
 *   offset 18 : maxStorage        U16
 *   offset 20 : maxFunctionDefs   U16
 *   offset 22 : maxInstructionDefs U16
 *   offset 24 : maxStackElements  U16
 *   offset 26 : maxSizeOfInstructions U16
 *   offset 28 : maxComponentElements  U16
 *   ... (remaining fields not needed)
 */
function parseMaxp(table: SFNTTable): MaxpData {
	const s = new Stream(table.buf, table.bufSize);
	const version = s.readU32();
	const numGlyphs = s.readU16();

	let maxPoints = 0;
	let maxContours = 0;
	let maxSizeOfInstructions = 0;
	let maxComponentElements = 0;

	if (version === 0x00010000) {
		maxPoints = s.readU16(); // offset 6
		maxContours = s.readU16(); // offset 8
		s.readU16(); // maxCompositePoints  (offset 10)
		s.readU16(); // maxCompositeContours (offset 12)
		s.readU16(); // maxZones            (offset 14)
		s.readU16(); // maxTwilightPoints   (offset 16)
		s.readU16(); // maxStorage          (offset 18)
		s.readU16(); // maxFunctionDefs     (offset 20)
		s.readU16(); // maxInstructionDefs  (offset 22)
		s.readU16(); // maxStackElements    (offset 24)
		maxSizeOfInstructions = s.readU16(); // offset 26
		maxComponentElements = s.readU16(); // offset 28
	}

	return {
		numGlyphs,
		maxPoints,
		maxContours,
		maxSizeOfInstructions,
		maxComponentElements,
	};
}

// ---------------------------------------------------------------------------
// parseCTF — main entry point
// ---------------------------------------------------------------------------

/**
 * Parse a CTF (Compact TrueType Font) container from the three LZCOMP-
 * decompressed streams and produce an `SFNTContainer` that can be
 * serialized into a standard TrueType font file.
 *
 * @param streams  Three `Stream` objects produced by MTX decompression:
 *                   [0] = glyph / table data
 *                   [1] = push instruction data
 *                   [2] = hinting code data
 * @returns An `SFNTContainer` holding all reconstructed SFNT tables.
 */
export function parseCTF(streams: Stream[], options?: ParseCTFOptions): SFNTContainer {
	const s0 = streams[0];
	const droppedTables: string[] = [];

	// --- Read SFNT offset (header) table -----------------------------------
	const _scalarType = s0.readU32();
	const numTables = s0.readU16();
	const _searchRange = s0.readU16();
	const _entrySelector = s0.readU16();
	const _rangeShift = s0.readU16();

	// --- Read table directory entries --------------------------------------
	const tables: SFNTTable[] = [];

	// Indices for special-case tables
	let glyfIdx = -1;
	let locaIdx = -1;
	let maxpIdx = -1;
	let headIdx = -1;
	let hmtxIdx = -1;
	let _cvtIdx = -1;

	for (let i = 0; i < numTables; i++) {
		// Read 4-byte ASCII tag
		const tag = s0.readChar() + s0.readChar() + s0.readChar() + s0.readChar();

		// Skip "hdmx" and "VDMX" tables entirely (12 bytes: checksum + offset + size).
		// MTX does not round-trip these; libeot logs a warning when it drops them,
		// so we record the tag and notify any caller-supplied `onWarn` hook.
		if (tag === 'hdmx' || tag === 'VDMX') {
			s0.seekRelative(12);
			droppedTables.push(tag);
			options?.onWarn?.(`Ignoring ${tag} table — MTX does not preserve it`);
			continue;
		}

		// Read checksum (4 bytes — skipped but consumed), offset, and size
		s0.seekRelative(4); // skip checksum
		const offset = s0.readU32();
		const size = s0.readU32();

		const table: SFNTTable = {
			tag,
			offset,
			bufSize: size,
			buf: new Uint8Array(0),
			checksum: 0,
		};

		const idx = tables.length;
		tables.push(table);

		// Track special tables by index
		if (tag === 'glyf') {
			glyfIdx = idx;
		} else if (tag === 'loca') {
			locaIdx = idx;
		} else if (tag === 'maxp') {
			maxpIdx = idx;
		} else if (tag === 'head') {
			headIdx = idx;
		} else if (tag === 'hmtx') {
			hmtxIdx = idx;
		} else if (tag === 'cvt ') {
			_cvtIdx = idx;
		}
	}

	// --- Load table data ---------------------------------------------------
	for (let i = 0; i < tables.length; i++) {
		const table = tables[i];

		// glyf and loca are populated later from the decoded glyph data
		if (table.tag === 'glyf' || table.tag === 'loca') {
			continue;
		}

		if (table.tag === 'cvt ') {
			// CVT is delta-encoded in the CTF stream
			unpackCVT(table, s0);
			continue;
		}

		// Normal table: copy raw bytes from stream 0
		s0.seekAbsolute(table.offset);
		const buf = new Uint8Array(table.bufSize);
		for (let b = 0; b < table.bufSize; b++) {
			buf[b] = s0.readU8();
		}
		table.buf = buf;

		// For the `head` table, zero out bytes 8–11 (checksumAdjustment).
		// Guard the length first: JS silently ignores out-of-range typed-array
		// writes, so without this a truncated head would be accepted silently
		// (libeot returns EOT_MALFORMED_HEAD_TABLE for bufSize < 12).
		if (table.tag === 'head') {
			if (table.bufSize < 12) {
				throw new EotError(
					EotErrorCode.MalformedHeadTable,
					`head table too small: ${table.bufSize} bytes (need at least 12)`,
				);
			}
			table.buf[8] = 0;
			table.buf[9] = 0;
			table.buf[10] = 0;
			table.buf[11] = 0;
		}
	}

	// --- Require the structural tables -------------------------------------
	// libeot (parseCTF.c:782-790) rejects a font missing maxp/head/hmtx rather
	// than proceeding with fabricated defaults. Substituting zero-defaults here
	// would decode a structurally valid but empty/garbage font instead of
	// surfacing the corruption.
	if (maxpIdx < 0) {
		throw new EotError(EotErrorCode.NoMaxpTable, 'CTF font is missing a maxp table');
	}
	if (headIdx < 0) {
		throw new EotError(EotErrorCode.NoHeadTable, 'CTF font is missing a head table');
	}
	if (hmtxIdx < 0) {
		throw new EotError(EotErrorCode.NoHmtxTable, 'CTF font is missing an hmtx table');
	}

	// --- Parse head and maxp for glyph decoding parameters -----------------
	const headData: HeadData = parseHead(tables[headIdx]);
	const maxpData: MaxpData = parseMaxp(tables[maxpIdx]);

	// --- Decode glyf and build loca ----------------------------------------
	if (glyfIdx >= 0) {
		// Add a loca table if one was not present in the directory
		if (locaIdx < 0) {
			const locaTable: SFNTTable = {
				tag: 'loca',
				offset: 0,
				bufSize: 0,
				buf: new Uint8Array(0),
				checksum: 0,
			};
			locaIdx = tables.length;
			tables.push(locaTable);
		}

		populateGlyfAndLoca(tables[glyfIdx], tables[locaIdx], headData, maxpData, streams);
	}

	return droppedTables.length > 0 ? { tables, droppedTables } : { tables };
}
