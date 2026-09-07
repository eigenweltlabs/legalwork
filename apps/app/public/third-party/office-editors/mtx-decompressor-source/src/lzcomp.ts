/**
 * LZCOMP decompression module for MicroType Express (MTX) fonts.
 * Ported from libeot (MPL 2.0) — lzcomp.c
 *
 * Implements LZCOMP sliding-window decompression with optional
 * run-length decoding on the output stream.
 */

import { AHuff } from './ahuff';
import { BitIO } from './bitio';
import { EotError, EotErrorCode } from './errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of bits used for each length chunk (excluding the stop bit). */
const LEN_WIDTH = 3;

/** Number of bits used for each distance chunk. */
const DIST_WIDTH = 3;

/** Number of data bits per length chunk (LEN_WIDTH − 1). */
const BIT_RANGE = LEN_WIDTH - 1; // 2

/** Distances >= this threshold add 1 to the decoded length. */
const MAX_2BYTE_DIST = 512;

/**
 * Size (in bytes) of the deterministic preload written into the sliding
 * window before decompression begins: 2 * 32 * 96 + 4 * 256 = 7168.
 */
const PRELOAD_SIZE = 2 * 32 * 96 + 4 * 256; // 7168

/** Minimum match length returned by decodeLength. */
const LEN_MIN = 2;

/** Minimum match distance returned by decodeDistance. */
const DIST_MIN = 1;

/**
 * Hard cap on the declared LZCOMP output length. The `out_len` header field is
 * 24 bits wide (see `readValue(24)` below), so 2^24 - 1 is the largest value an
 * encoder can legally emit; anything above that is corrupt input, not a large
 * font. Capping lower would reject legitimate fonts (e.g. large CJK glyph
 * streams that exceed a few MiB uncompressed).
 */
const MAX_OUT_LEN = (1 << 24) - 1; // 16 MiB - 1 (24-bit field maximum)

/**
 * Hard cap on RLE-expanded output growth. RLE can legally expand up to 255:1
 * per escape triple, so the expanded stream can exceed the declared `out_len`.
 * Bound it a small multiple above the 24-bit maximum to stop a hostile stream
 * from growing the buffer without limit while still admitting real fonts.
 */
const MAX_OUT = 64 * 1024 * 1024; // 64 MiB

// ---------------------------------------------------------------------------
// RLE state constants
// ---------------------------------------------------------------------------

const RLE_INITIAL = 0;
const RLE_NORMAL = 1;
const RLE_SEEN_ESCAPE = 2;
const RLE_NEED_BYTE = 3;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Compute the number of distance ranges and the special-symbol indices
 * that depend on the total output length.
 */
function setDistRange(length: number) {
	let numDistRanges = 1;
	let distMax = DIST_MIN + ((1 << (DIST_WIDTH * numDistRanges)) - 1);

	while (distMax < length) {
		numDistRanges++;
		// Defense-in-depth: cap numDistRanges to prevent runaway loop or
		// out-of-range left-shifts when `length` is corrupted.
		if (numDistRanges > 8) {
			throw new Error('LZCOMP setDistRange: numDistRanges exceeds bound (8)');
		}
		distMax = DIST_MIN + ((1 << (DIST_WIDTH * numDistRanges)) - 1);
	}

	// Special symbols that follow all length/distance pairs in the alphabet:
	//   DUP2 — duplicate the byte 2 positions back
	//   DUP4 — duplicate the byte 4 positions back
	//   DUP6 — duplicate the byte 6 positions back
	const DUP2 = 256 + (1 << LEN_WIDTH) * numDistRanges;
	const DUP4 = DUP2 + 1;
	const DUP6 = DUP4 + 1;
	const NUM_SYMS = DUP6 + 1;

	return { numDistRanges, distMax, DUP2, DUP4, DUP6, NUM_SYMS };
}

/**
 * Pre-load the sliding window with deterministic data so that
 * early back-references can match known patterns.
 */
function initializeModel(window: Uint8Array): void {
	let i = 0;

	// First region: 32 × 96 pairs of (k, j)
	for (let k = 0; k < 32; k++) {
		for (let j = 0; j < 96; j++) {
			window[i++] = k;
			window[i++] = j;
		}
	}

	// Second region: groups of 4 identical bytes for j = 0..255
	let j = 0;
	while (i < PRELOAD_SIZE && j < 256) {
		window[i++] = j;
		window[i++] = j;
		window[i++] = j;
		window[i++] = j;
		j++;
	}
}

/**
 * Decode a match length using a stop-bit scheme.
 *
 * Each chunk contributes `BIT_RANGE` (2) data bits.  Bit 2 of each chunk
 * is the *continuation* bit:
 *   - bit 2 SET   (1) → more chunks follow
 *   - bit 2 CLEAR (0) → this is the last chunk
 *
 * The first chunk is derived from the already-decoded main symbol; any
 * subsequent chunks are read from `lenEcoder`.
 *
 * @param lenEcoder   Adaptive Huffman tree for length continuation symbols.
 * @param symbol      The main symbol that triggered a copy operation (>= 256).
 * @param numDistRangesOut  Output parameter — receives the number of distance
 *                          ranges for the subsequent distance decode.
 * @returns The decoded match length (>= LEN_MIN).
 */
function decodeLength(lenEcoder: AHuff, symbol: number, numDistRangesOut: number[]): number {
	const mask = 1 << BIT_RANGE; // 4  — the continuation / stop bit
	let firstTime = true;
	let value = 0;
	let done: boolean;
	let iters = 0;

	do {
		// Defense-in-depth: cap iteration count to prevent unbounded loops on
		// adversarial input (each chunk is 3 bits ⇒ 16 chunks ≫ any sane length).
		if (++iters > 16) {
			throw new Error('LZCOMP decodeLength: iteration cap exceeded');
		}
		let bits: number;

		if (firstTime) {
			bits = symbol - 256;
			firstTime = false;

			// The high part of the first chunk encodes which distance range to use.
			numDistRangesOut[0] = Math.floor(bits / (1 << LEN_WIDTH)) + 1;
			bits %= 1 << LEN_WIDTH;
		} else {
			bits = lenEcoder.readSymbol();
		}

		// Stop-bit logic (from the C code):
		//   done = (bits & mask) == 0
		//   while (!done)
		// Bit 2 CLEAR → done = true  → exit loop  (last chunk)
		// Bit 2 SET   → done = false → keep going  (more chunks)
		done = (bits & mask) === 0;

		// Strip the continuation bit; keep only the lower BIT_RANGE data bits.
		bits &= ~mask;

		value <<= BIT_RANGE;
		value |= bits;
	} while (!done);

	value += LEN_MIN;
	return value;
}

/**
 * Decode a match distance by reading `numDistRanges` chunks from the
 * distance Huffman tree, each contributing `DIST_WIDTH` (3) bits.
 */
function decodeDistance(distEcoder: AHuff, numDistRanges: number): number {
	let value = 0;

	for (let i = numDistRanges; i > 0; i--) {
		const bits = distEcoder.readSymbol();
		value <<= DIST_WIDTH;
		value |= bits;
	}

	value += DIST_MIN;
	return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decompress an LZCOMP-compressed byte stream, optionally followed by
 * run-length decoding.
 *
 * @param data     The compressed input bytes.
 * @param size     Number of valid bytes in `data`.
 * @param version  MTX version flag.  When version !== 1 a leading bit
 *                 indicates whether run-length encoding is used on the
 *                 output.
 * @returns The decompressed byte array.
 */
export function lzcompDecompress(data: Uint8Array, size: number, version: number): Uint8Array {
	const bio = new BitIO(data, 0, size);

	// --- Run-length flag ---------------------------------------------------
	let usingRunLength: boolean;
	if (version === 1) {
		usingRunLength = false;
	} else {
		usingRunLength = bio.inputBit();
	}

	// --- Create Huffman trees for distance and length ----------------------
	const distEcoder = new AHuff(bio, 1 << DIST_WIDTH); // 8 symbols
	const lenEcoder = new AHuff(bio, 1 << LEN_WIDTH); // 8 symbols

	// --- Read expected output length (24-bit big-endian) -------------------
	const outLen = bio.readValue(24);

	// Cap declared output length so a hostile stream cannot allocate huge
	// buffers (sliding window + outBuf are sized from this value).
	if (outLen > MAX_OUT_LEN) {
		throw new Error(`LZCOMP outLen ${outLen} exceeds maximum (${MAX_OUT_LEN})`);
	}

	// --- Compute distance-range parameters ---------------------------------
	const { DUP2, DUP4, DUP6, NUM_SYMS } = setDistRange(outLen);

	// --- Create symbol Huffman tree ----------------------------------------
	const symEcoder = new AHuff(bio, NUM_SYMS);

	// --- Sliding window: PRELOAD_SIZE prefix + outLen working area ---------
	const windowSize = PRELOAD_SIZE + outLen;
	const win = new Uint8Array(windowSize);
	initializeModel(win);

	// Base offset into the window for decompressed data.
	const base = PRELOAD_SIZE;

	// --- Output buffer (may grow if RLE expands data) ----------------------
	let outBufSize = outLen;
	let outBuf = new Uint8Array(outBufSize);
	let outIdx = 0;

	// --- RLE decoder state -------------------------------------------------
	let rleState = RLE_INITIAL;
	let rleEscape = 0;
	let rleCount = 0;

	/**
	 * Emit a single decompressed byte, optionally passing it through the
	 * inline run-length decoder before writing to the output buffer.
	 */
	const emitByte = (byte: number): void => {
		if (!usingRunLength) {
			// Fast path: no RLE, just append.
			if (outIdx >= outBufSize) {
				outBufSize += outBufSize >>> 1;
				if (outBufSize > MAX_OUT) {
					throw new Error('LZCOMP output exceeds maximum size budget');
				}
				const tmp = new Uint8Array(outBufSize);
				tmp.set(outBuf);
				outBuf = tmp;
			}
			outBuf[outIdx++] = byte;
			return;
		}

		// RLE state machine
		switch (rleState) {
			case RLE_INITIAL:
				// The very first byte is the escape sentinel.
				rleEscape = byte;
				rleState = RLE_NORMAL;
				break;

			case RLE_NORMAL:
				if (byte === rleEscape) {
					rleState = RLE_SEEN_ESCAPE;
				} else {
					if (outIdx >= outBufSize) {
						outBufSize += outBufSize >>> 1;
						if (outBufSize > MAX_OUT) {
							throw new Error('LZCOMP output exceeds maximum size budget');
						}
						const tmp = new Uint8Array(outBufSize);
						tmp.set(outBuf);
						outBuf = tmp;
					}
					outBuf[outIdx++] = byte;
				}
				break;

			case RLE_SEEN_ESCAPE:
				rleCount = byte;
				if (rleCount === 0) {
					// Escaped escape: emit the escape byte itself.
					if (outIdx >= outBufSize) {
						outBufSize += outBufSize >>> 1;
						if (outBufSize > MAX_OUT) {
							throw new Error('LZCOMP output exceeds maximum size budget');
						}
						const tmp = new Uint8Array(outBufSize);
						tmp.set(outBuf);
						outBuf = tmp;
					}
					outBuf[outIdx++] = rleEscape;
					rleState = RLE_NORMAL;
				} else {
					rleState = RLE_NEED_BYTE;
				}
				break;

			case RLE_NEED_BYTE: {
				// Emit `rleCount` copies of `byte`.
				if (outIdx + rleCount > outBufSize) {
					outBufSize = outIdx + rleCount + (outBufSize >>> 1);
					if (outBufSize > MAX_OUT) {
						throw new Error('LZCOMP output exceeds maximum size budget');
					}
					const tmp = new Uint8Array(outBufSize);
					tmp.set(outBuf);
					outBuf = tmp;
				}
				for (let i = 0; i < rleCount; i++) {
					outBuf[outIdx++] = byte;
				}
				rleState = RLE_NORMAL;
				break;
			}
		}
	};

	// --- Main decode loop --------------------------------------------------
	// `pos` is hoisted so the post-loop bounds check can inspect its final
	// value: the copy branch advances `pos` without re-testing the loop
	// condition, so a corrupt stream can drive it past `outLen`.
	let pos = 0;
	for (; pos < outLen; ) {
		const symbol = symEcoder.readSymbol();

		let value: number;

		if (symbol < 256) {
			// Literal byte
			value = symbol;
		} else if (symbol === DUP2) {
			// Duplicate byte 2 positions back
			value = win[base + pos - 2];
		} else if (symbol === DUP4) {
			// Duplicate byte 4 positions back
			value = win[base + pos - 4];
		} else if (symbol === DUP6) {
			// Duplicate byte 6 positions back
			value = win[base + pos - 6];
		} else {
			// ---- Copy item (back-reference) ----
			const numDistRangesRef = [0];
			let length = decodeLength(lenEcoder, symbol, numDistRangesRef);
			const distance = decodeDistance(distEcoder, numDistRangesRef[0]);

			// Long distances add one extra byte to the match length.
			if (distance >= MAX_2BYTE_DIST) {
				length++;
			}

			const start = base + pos - distance - length + 1;
			for (let j = 0; j < length; j++) {
				value = win[start + j];
				win[base + pos] = value;
				pos++;
				emitByte(value);
			}
			continue; // pos already advanced inside the loop
		}

		// Single-byte cases (literal / DUP2 / DUP4 / DUP6)
		win[base + pos] = value;
		pos++;
		emitByte(value);
	}

	// A well-formed stream lands exactly on `outLen`. A final copy item can
	// overshoot; libeot raises ERR_LZCOMP_Decode_bounds here rather than
	// returning the trailing garbage the overshoot produced.
	if (pos !== outLen) {
		throw new EotError(
			EotErrorCode.MtxError,
			`LZCOMP decode overran output: pos=${pos}, expected=${outLen}`,
		);
	}

	return outBuf.subarray(0, outIdx);
}
