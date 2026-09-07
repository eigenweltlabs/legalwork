/**
 * Triplet encoding table for CTF glyph coordinate decoding.
 * Ported from libeot (MPL 2.0) triplet_encodings.c
 * See: http://www.w3.org/Submission/MTX/#TripletEncoding
 */

export interface TripletEncoding {
	/** Total number of bytes consumed (including the flag byte). */
	byteCount: number;
	/** Number of bits for the X coordinate delta. */
	xBits: number;
	/** Number of bits for the Y coordinate delta. */
	yBits: number;
	/** Base offset added to the raw X value. */
	deltaX: number;
	/** Base offset added to the raw Y value. */
	deltaY: number;
	/** Sign multiplier for X (-1 or 1). */
	xSign: number;
	/** Sign multiplier for Y (-1 or 1). */
	ySign: number;
}

export const TRIPLET_ENCODINGS: TripletEncoding[] = [
	// Indices 0-9: xBits=0 or yBits=0 (one axis)
	{ byteCount: 2, xBits: 0, yBits: 8, deltaX: 0, deltaY: 0, xSign: 0, ySign: -1 },
	{ byteCount: 2, xBits: 0, yBits: 8, deltaX: 0, deltaY: 0, xSign: 0, ySign: 1 },
	{ byteCount: 2, xBits: 0, yBits: 8, deltaX: 0, deltaY: 256, xSign: 0, ySign: -1 },
	{ byteCount: 2, xBits: 0, yBits: 8, deltaX: 0, deltaY: 256, xSign: 0, ySign: 1 },
	{ byteCount: 2, xBits: 0, yBits: 8, deltaX: 0, deltaY: 512, xSign: 0, ySign: -1 },
	{ byteCount: 2, xBits: 0, yBits: 8, deltaX: 0, deltaY: 512, xSign: 0, ySign: 1 },
	{ byteCount: 2, xBits: 0, yBits: 8, deltaX: 0, deltaY: 768, xSign: 0, ySign: -1 },
	{ byteCount: 2, xBits: 0, yBits: 8, deltaX: 0, deltaY: 768, xSign: 0, ySign: 1 },
	{ byteCount: 2, xBits: 0, yBits: 8, deltaX: 0, deltaY: 1024, xSign: 0, ySign: -1 },
	{ byteCount: 2, xBits: 0, yBits: 8, deltaX: 0, deltaY: 1024, xSign: 0, ySign: 1 },
	// Indices 10-19: yBits=0 (X axis only)
	{ byteCount: 2, xBits: 8, yBits: 0, deltaX: 0, deltaY: 0, xSign: -1, ySign: 0 },
	{ byteCount: 2, xBits: 8, yBits: 0, deltaX: 0, deltaY: 0, xSign: 1, ySign: 0 },
	{ byteCount: 2, xBits: 8, yBits: 0, deltaX: 256, deltaY: 0, xSign: -1, ySign: 0 },
	{ byteCount: 2, xBits: 8, yBits: 0, deltaX: 256, deltaY: 0, xSign: 1, ySign: 0 },
	{ byteCount: 2, xBits: 8, yBits: 0, deltaX: 512, deltaY: 0, xSign: -1, ySign: 0 },
	{ byteCount: 2, xBits: 8, yBits: 0, deltaX: 512, deltaY: 0, xSign: 1, ySign: 0 },
	{ byteCount: 2, xBits: 8, yBits: 0, deltaX: 768, deltaY: 0, xSign: -1, ySign: 0 },
	{ byteCount: 2, xBits: 8, yBits: 0, deltaX: 768, deltaY: 0, xSign: 1, ySign: 0 },
	{ byteCount: 2, xBits: 8, yBits: 0, deltaX: 1024, deltaY: 0, xSign: -1, ySign: 0 },
	{ byteCount: 2, xBits: 8, yBits: 0, deltaX: 1024, deltaY: 0, xSign: 1, ySign: 0 },
	// Indices 20-83: 4-bit X + 4-bit Y (2 bytes total)
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 1, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 1, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 1, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 1, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 17, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 17, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 17, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 17, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 33, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 33, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 33, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 33, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 49, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 49, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 49, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 1, deltaY: 49, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 1, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 1, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 1, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 1, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 17, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 17, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 17, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 17, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 33, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 33, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 33, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 33, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 49, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 49, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 49, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 17, deltaY: 49, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 1, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 1, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 1, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 1, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 17, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 17, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 17, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 17, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 33, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 33, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 33, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 33, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 49, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 49, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 49, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 33, deltaY: 49, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 1, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 1, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 1, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 1, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 17, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 17, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 17, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 17, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 33, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 33, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 33, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 33, xSign: 1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 49, xSign: -1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 49, xSign: 1, ySign: -1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 49, xSign: -1, ySign: 1 },
	{ byteCount: 2, xBits: 4, yBits: 4, deltaX: 49, deltaY: 49, xSign: 1, ySign: 1 },
	// Indices 84-119: 8-bit X + 8-bit Y (3 bytes total)
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 1, xSign: -1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 1, xSign: 1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 1, xSign: -1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 1, xSign: 1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 257, xSign: -1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 257, xSign: 1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 257, xSign: -1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 257, xSign: 1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 513, xSign: -1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 513, xSign: 1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 513, xSign: -1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 1, deltaY: 513, xSign: 1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 1, xSign: -1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 1, xSign: 1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 1, xSign: -1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 1, xSign: 1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 257, xSign: -1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 257, xSign: 1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 257, xSign: -1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 257, xSign: 1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 513, xSign: -1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 513, xSign: 1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 513, xSign: -1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 257, deltaY: 513, xSign: 1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 1, xSign: -1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 1, xSign: 1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 1, xSign: -1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 1, xSign: 1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 257, xSign: -1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 257, xSign: 1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 257, xSign: -1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 257, xSign: 1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 513, xSign: -1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 513, xSign: 1, ySign: -1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 513, xSign: -1, ySign: 1 },
	{ byteCount: 3, xBits: 8, yBits: 8, deltaX: 513, deltaY: 513, xSign: 1, ySign: 1 },
	// Indices 120-123: 12-bit X + 12-bit Y (4 bytes total)
	{ byteCount: 4, xBits: 12, yBits: 12, deltaX: 0, deltaY: 0, xSign: -1, ySign: -1 },
	{ byteCount: 4, xBits: 12, yBits: 12, deltaX: 0, deltaY: 0, xSign: 1, ySign: -1 },
	{ byteCount: 4, xBits: 12, yBits: 12, deltaX: 0, deltaY: 0, xSign: -1, ySign: 1 },
	{ byteCount: 4, xBits: 12, yBits: 12, deltaX: 0, deltaY: 0, xSign: 1, ySign: 1 },
	// Indices 124-127: 16-bit X + 16-bit Y (5 bytes total)
	{ byteCount: 5, xBits: 16, yBits: 16, deltaX: 0, deltaY: 0, xSign: -1, ySign: -1 },
	{ byteCount: 5, xBits: 16, yBits: 16, deltaX: 0, deltaY: 0, xSign: 1, ySign: -1 },
	{ byteCount: 5, xBits: 16, yBits: 16, deltaX: 0, deltaY: 0, xSign: -1, ySign: 1 },
	{ byteCount: 5, xBits: 16, yBits: 16, deltaX: 0, deltaY: 0, xSign: 1, ySign: 1 },
];
