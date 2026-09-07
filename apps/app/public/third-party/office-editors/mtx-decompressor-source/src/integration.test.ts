/**
 * Integration tests for the MTX decompression pipeline.
 *
 * These tests construct valid CTF (Compact TrueType Font) data by hand
 * and exercise the full parseCTF → dumpContainer pipeline, verifying
 * that the output is a valid TrueType font with correct glyph data.
 *
 * Prior to the interleaving fix, parseCTF read all per-point flag bytes
 * contiguously before reading coordinate data.  In the CTF format,
 * flag and coordinate bytes are interleaved per point:
 *   [flag0, coord0, flag1, coord1, ...]
 * Pre-reading all flags consumed coordinate bytes as flags and
 * completely corrupted the glyph data.
 */
import { describe, it, expect } from 'vitest';

import { parseCTF } from './ctf-parser';
import type { SFNTContainer } from './ctf-parser';
import { decompressMtx, decompressEotFont } from './mtx-decompress';
import { dumpContainer } from './sfnt-builder';
import { Stream } from './stream';
import { TRIPLET_ENCODINGS } from './triplet-encodings';

// ===================================================================
// Test data builders
// ===================================================================

/** Write a 4-byte ASCII tag to a stream. */
function writeTag(s: Stream, tag: string): void {
	for (let i = 0; i < 4; i++) {
		s.writeU8(tag.charCodeAt(i));
	}
}

/** Largest power of 2 <= n. */
function maxPow2(n: number): number {
	let ret = 0;
	while (1 << (ret + 1) <= n) {
		ret++;
	}
	return 1 << ret;
}

/** Floor of log2(n). */
function lgFloor(n: number): number {
	let ret = 0;
	let v = n;
	while (v > 1) {
		v = Math.floor(v / 2);
		ret++;
	}
	return ret;
}

/**
 * Build a minimal 54-byte `head` table.
 *
 * @param indexToLocFormat 0 = short loca (U16 offsets / 2), 1 = long loca (U32 offsets)
 */
function buildHeadTable(indexToLocFormat: number = 0): Uint8Array {
	const s = new Stream(null, 0);
	s.reserve(54);

	s.writeU32(0x00010000); // version
	s.writeU32(0x00010000); // fontRevision
	s.writeU32(0x00000000); // checksumAdjustment (zeroed by parseCTF anyway)
	s.writeU32(0x5f0f3cf5); // magicNumber
	s.writeU16(0x000b); // flags
	s.writeU16(1000); // unitsPerEm
	s.writeU32(0);
	s.writeU32(0); // created (8 bytes)
	s.writeU32(0);
	s.writeU32(0); // modified (8 bytes)
	s.writeS16(0); // xMin
	s.writeS16(0); // yMin
	s.writeS16(1000); // xMax
	s.writeS16(1000); // yMax
	s.writeU16(0); // macStyle
	s.writeU16(8); // lowestRecPPEM
	s.writeS16(2); // fontDirectionHint
	s.writeS16(indexToLocFormat);
	s.writeS16(0); // glyphDataFormat

	return s.toUint8Array();
}

/**
 * Build a 32-byte `maxp` (version 1.0) table.
 */
function buildMaxpTable(
	numGlyphs: number,
	maxPoints: number,
	maxContours: number,
	maxSizeOfInstructions: number = 0,
	maxComponentElements: number = 0,
): Uint8Array {
	const s = new Stream(null, 0);
	s.reserve(32);

	s.writeU32(0x00010000); // version
	s.writeU16(numGlyphs);
	s.writeU16(maxPoints);
	s.writeU16(maxContours);
	s.writeU16(0); // maxCompositePoints
	s.writeU16(0); // maxCompositeContours
	s.writeU16(2); // maxZones
	s.writeU16(0); // maxTwilightPoints
	s.writeU16(0); // maxStorage
	s.writeU16(0); // maxFunctionDefs
	s.writeU16(0); // maxInstructionDefs
	s.writeU16(0); // maxStackElements
	s.writeU16(maxSizeOfInstructions);
	s.writeU16(maxComponentElements);
	s.writeU16(0); // maxComponentDepth

	return s.toUint8Array();
}

/** Triplet point definition for CTF glyph data construction. */
interface TripletPoint {
	/** Triplet encoding index (0-127). */
	tripletIdx: number;
	/** Whether the point is on the curve. */
	onCurve: boolean;
	/** Raw coordinate bytes to write after the flag byte. */
	coordBytes: number[];
	/** Expected decoded delta X. */
	dx: number;
	/** Expected decoded delta Y. */
	dy: number;
}

/**
 * Create a triplet point using index 23 = { byteCount: 2, xBits: 4, yBits: 4,
 *   deltaX: 1, deltaY: 1, xSign: 1, ySign: 1 }.
 */
function tripletXY(xRaw: number, yRaw: number, onCurve: boolean = true): TripletPoint {
	const tripletIdx = 23;
	const enc = TRIPLET_ENCODINGS[tripletIdx];
	return {
		tripletIdx,
		onCurve,
		coordBytes: [(xRaw << 4) | (yRaw & 0x0f)],
		dx: (xRaw + enc.deltaX) * enc.xSign,
		dy: (yRaw + enc.deltaY) * enc.ySign,
	};
}

/** Triplet point using index 11 = X-only (8-bit, positive). */
function tripletX(xVal: number, onCurve: boolean = true): TripletPoint {
	return { tripletIdx: 11, onCurve, coordBytes: [xVal], dx: xVal, dy: 0 };
}

/** Triplet point using index 1 = Y-only (8-bit, positive). */
function tripletY(yVal: number, onCurve: boolean = true): TripletPoint {
	return { tripletIdx: 1, onCurve, coordBytes: [yVal], dx: 0, dy: yVal };
}

/**
 * Write an array of triplet points to a stream in CTF format:
 * ALL flag bytes first, then ALL coordinate bytes (NOT interleaved).
 */
function writeTripletPoints(s: Stream, points: TripletPoint[]): void {
	// First pass: write all flag bytes
	for (const p of points) {
		const flag = (p.onCurve ? 0x00 : 0x80) | p.tripletIdx;
		s.writeU8(flag);
	}
	// Second pass: write all coordinate bytes
	for (const p of points) {
		for (const b of p.coordBytes) {
			s.writeU8(b);
		}
	}
}

/**
 * Write a 255UShort value to a stream (variable-length encoding).
 * For values 0..252, it's a single byte.
 */
function write255UShort(s: Stream, value: number): void {
	if (value < 253) {
		s.writeU8(value);
	} else if (value < 506) {
		s.writeU8(255);
		s.writeU8(value - 253);
	} else if (value < 762) {
		s.writeU8(254);
		s.writeU8(value - 506);
	} else {
		s.writeU8(253);
		s.writeU16(value);
	}
}

interface CTFStreamOptions {
	tables: Array<{ tag: string; data: Uint8Array }>;
	glyphData: Uint8Array;
}

/**
 * Build a complete CTF stream 0 (SFNT header + table directory +
 * table data + glyph data at the glyf offset).
 */
function buildCTFStream0(opts: CTFStreamOptions): Uint8Array {
	// parseCTF requires head, maxp, and hmtx to be present (it errors otherwise).
	// hmtx is loaded raw and only presence-checked, so a minimal record suffices;
	// inject one when a caller didn't supply it so fixtures stay concise.
	const inputTables = opts.tables.some((t) => t.tag === 'hmtx')
		? opts.tables
		: [...opts.tables, { tag: 'hmtx', data: new Uint8Array([0, 0, 0, 0]) }];

	// We need head, maxp, glyf + any extra tables
	const allTags = inputTables.map((t) => t.tag).concat(['glyf']);
	const numTables = allTags.length;

	const headerSize = 12;
	const dirSize = numTables * 16;
	const dataStart = headerSize + dirSize;

	// Compute table offsets
	let offset = dataStart;
	const tableLayouts: Array<{
		tag: string;
		offset: number;
		size: number;
		data: Uint8Array | null;
	}> = [];

	for (const t of inputTables) {
		tableLayouts.push({ tag: t.tag, offset, size: t.data.length, data: t.data });
		offset += t.data.length;
	}

	// glyf table — data is at the end, size is informational (parseCTF reads until done)
	const glyfOffset = offset;
	tableLayouts.push({ tag: 'glyf', offset: glyfOffset, size: opts.glyphData.length, data: null });
	offset += opts.glyphData.length;

	const totalSize = offset;
	const s = new Stream(null, 0);
	s.reserve(totalSize);

	// SFNT header
	const searchRange = maxPow2(numTables) * 16;
	const entrySelector = lgFloor(numTables);
	const rangeShift = numTables * 16 - searchRange;

	s.writeU32(0x00010000); // scalarType (TrueType)
	s.writeU16(numTables);
	s.writeU16(searchRange);
	s.writeU16(entrySelector);
	s.writeU16(rangeShift);

	// Table directory
	for (const tl of tableLayouts) {
		writeTag(s, tl.tag);
		s.writeU32(0); // checksum (not used by parseCTF)
		s.writeU32(tl.offset);
		s.writeU32(tl.size);
	}

	// Table data (non-glyf)
	for (const tl of tableLayouts) {
		if (tl.data) {
			for (let i = 0; i < tl.data.length; i++) {
				s.writeU8(tl.data[i]);
			}
		}
	}

	// Glyph data
	for (let i = 0; i < opts.glyphData.length; i++) {
		s.writeU8(opts.glyphData[i]);
	}

	return s.toUint8Array();
}

/**
 * Build glyph data for a simple triangle glyph (1 contour, 3 points).
 *
 * CTF format: flags and coordinate bytes are stored SEPARATELY —
 * all flag bytes first, then all coordinate bytes.
 */
function buildTriangleGlyphData(): {
	data: Uint8Array;
	expectedDeltas: Array<{ dx: number; dy: number; onCurve: boolean }>;
} {
	const s = new Stream(null, 0);
	s.reserve(64);

	s.writeS16(1); // numContours = 1
	// C format: totalPoints = 1 + pointsInContour for first contour
	// For 3 points total, write pointsInContour = 2
	write255UShort(s, 2);

	const points = [
		tripletXY(5, 5, true), // dx=6, dy=6
		tripletXY(9, 3, true), // dx=10, dy=4
		tripletXY(2, 7, true), // dx=3, dy=8
	];
	writeTripletPoints(s, points);

	write255UShort(s, 0); // pushCount
	write255UShort(s, 0); // codeSize

	return {
		data: s.toUint8Array(),
		expectedDeltas: points.map((p) => ({ dx: p.dx, dy: p.dy, onCurve: p.onCurve })),
	};
}

/**
 * Build glyph data for a rectangle (1 contour, 4 points with mixed
 * X-only and Y-only movements).
 */
function buildRectangleGlyphData(): {
	data: Uint8Array;
	expectedDeltas: Array<{ dx: number; dy: number; onCurve: boolean }>;
} {
	const s = new Stream(null, 0);
	s.reserve(128);

	s.writeS16(1);
	write255UShort(s, 3); // 4 points total = 1 + 3

	const points = [
		tripletX(100, true),
		tripletY(200, true),
		tripletX(50, true),
		tripletY(100, false),
	];
	writeTripletPoints(s, points);

	write255UShort(s, 0);
	write255UShort(s, 0);

	return {
		data: s.toUint8Array(),
		expectedDeltas: points.map((p) => ({ dx: p.dx, dy: p.dy, onCurve: p.onCurve })),
	};
}

/**
 * Build glyph data for 2 glyphs: a triangle and a rectangle.
 */
function buildMultiGlyphData(): Uint8Array {
	const s = new Stream(null, 0);
	s.reserve(256);

	// Glyph 0: simple triangle (1 contour, 3 points = 1 + 2)
	s.writeS16(1);
	write255UShort(s, 2);
	writeTripletPoints(s, [tripletXY(5, 5, true), tripletXY(9, 3, true), tripletXY(2, 7, true)]);
	write255UShort(s, 0);
	write255UShort(s, 0);

	// Glyph 1: another triangle (1 contour, 3 points = 1 + 2)
	s.writeS16(1);
	write255UShort(s, 2);
	writeTripletPoints(s, [tripletXY(1, 1, true), tripletXY(2, 2, false), tripletXY(3, 3, true)]);
	write255UShort(s, 0);
	write255UShort(s, 0);

	return s.toUint8Array();
}

/**
 * Build glyph data with a composite glyph (references other glyph).
 */
function buildCompositeGlyphData(): Uint8Array {
	const s = new Stream(null, 0);
	s.reserve(256);

	// Glyph 0: simple triangle (3 points = 1 + 2)
	s.writeS16(1);
	write255UShort(s, 2);
	writeTripletPoints(s, [tripletXY(5, 5, true), tripletXY(9, 3, true), tripletXY(2, 7, true)]);
	write255UShort(s, 0);
	write255UShort(s, 0);

	// Glyph 1: composite (numContours < 0)
	s.writeS16(-1);
	// Bounding box (explicit for composite)
	s.writeS16(0); // xMin
	s.writeS16(0); // yMin
	s.writeS16(100); // xMax
	s.writeS16(100); // yMax
	// Component: reference glyph 0 with byte offset args
	const flags = 0x0000; // no MORE_COMPONENTS, args are bytes, not words
	s.writeU16(flags);
	s.writeU16(0); // glyphIndex = 0
	// 2 argument bytes (S8 × 2): dx=10, dy=20
	s.writeU8(10);
	s.writeU8(20);

	return s.toUint8Array();
}

/**
 * Build a glyph with explicit bbox (numContours = 0x7FFF).
 */
function buildExplicitBboxGlyphData(): Uint8Array {
	const s = new Stream(null, 0);
	s.reserve(128);

	s.writeS16(0x7fff);
	s.writeS16(1);
	s.writeS16(10);
	s.writeS16(20);
	s.writeS16(200);
	s.writeS16(300);

	write255UShort(s, 1); // 2 points total = 1 + 1
	writeTripletPoints(s, [tripletXY(5, 5, true), tripletXY(3, 3, true)]);

	write255UShort(s, 0);
	write255UShort(s, 0);

	return s.toUint8Array();
}

/**
 * Assemble 3 CTF streams and run parseCTF + dumpContainer.
 */
function runCTFPipeline(
	stream0Data: Uint8Array,
	stream1Data?: Uint8Array,
	stream2Data?: Uint8Array,
): { container: SFNTContainer; ttfOutput: Uint8Array } {
	const s0 = new Stream(stream0Data, stream0Data.length);
	const s1 = new Stream(stream1Data ?? new Uint8Array(0), stream1Data?.length ?? 0);
	const s2 = new Stream(stream2Data ?? new Uint8Array(0), stream2Data?.length ?? 0);

	const container = parseCTF([s0, s1, s2]);
	const ttfOutput = dumpContainer(container);

	return { container, ttfOutput };
}

// ===================================================================
// Tests
// ===================================================================

describe('cTF integration — simple glyph (triangle)', () => {
	const { data: glyphData } = buildTriangleGlyphData();
	const head = buildHeadTable(0); // short loca
	const maxp = buildMaxpTable(1, 3, 1);
	const stream0 = buildCTFStream0({
		tables: [
			{ tag: 'head', data: head },
			{ tag: 'maxp', data: maxp },
		],
		glyphData,
	});

	it('parseCTF produces expected tables', () => {
		const { container } = runCTFPipeline(stream0);
		const tags = container.tables.map((t) => t.tag).sort();
		expect(tags).toContain('head');
		expect(tags).toContain('maxp');
		expect(tags).toContain('glyf');
		expect(tags).toContain('loca');
	});

	it('glyf table has non-zero data', () => {
		const { container } = runCTFPipeline(stream0);
		const glyf = container.tables.find((t) => t.tag === 'glyf')!;
		expect(glyf.bufSize).toBeGreaterThan(0);
		expect(glyf.buf.length).toBeGreaterThan(0);
	});

	it('loca table has correct number of entries for short format', () => {
		const { container } = runCTFPipeline(stream0);
		const loca = container.tables.find((t) => t.tag === 'loca')!;
		// Short loca: (numGlyphs + 1) × 2 bytes = (1 + 1) × 2 = 4 bytes
		expect(loca.bufSize).toBe(4);
	});

	it('output glyph contains correct numContours', () => {
		const { container } = runCTFPipeline(stream0);
		const glyf = container.tables.find((t) => t.tag === 'glyf')!;
		const s = new Stream(glyf.buf, glyf.bufSize);
		const numContours = s.readS16();
		expect(numContours).toBe(1);
	});

	it('output glyph has correct bounding box from point deltas', () => {
		const { container } = runCTFPipeline(stream0);
		const glyf = container.tables.find((t) => t.tag === 'glyf')!;
		const s = new Stream(glyf.buf, glyf.bufSize);

		s.readS16(); // numContours
		const xMin = s.readS16();
		const yMin = s.readS16();
		const xMax = s.readS16();
		const yMax = s.readS16();

		// Cumulative positions: P0(6,6), P1(16,10), P2(19,18)
		// Bounding box should cover all accumulated coordinates
		expect(xMin).toBeLessThanOrEqual(6);
		expect(yMin).toBeLessThanOrEqual(6);
		expect(xMax).toBeGreaterThanOrEqual(19);
		expect(yMax).toBeGreaterThanOrEqual(18);
	});

	it('output glyph has correct endPtsOfContours', () => {
		const { container } = runCTFPipeline(stream0);
		const glyf = container.tables.find((t) => t.tag === 'glyf')!;
		const s = new Stream(glyf.buf, glyf.bufSize);

		s.readS16(); // numContours
		s.readS16();
		s.readS16();
		s.readS16();
		s.readS16(); // bbox
		const endPt0 = s.readU16();
		expect(endPt0).toBe(2); // 3 points → last index = 2
	});

	it('dumpContainer produces valid TrueType output', () => {
		const { ttfOutput } = runCTFPipeline(stream0);

		// Valid TrueType starts with scalarType 0x00010000
		expect(ttfOutput.length).toBeGreaterThan(12);
		const sig = (ttfOutput[0] << 24) | (ttfOutput[1] << 16) | (ttfOutput[2] << 8) | ttfOutput[3];
		expect(sig >>> 0).toBe(0x00010000);
	});

	it('output font has correct number of tables', () => {
		const { ttfOutput } = runCTFPipeline(stream0);
		const numTables = (ttfOutput[4] << 8) | ttfOutput[5];
		// head, maxp, hmtx (injected by the fixture builder), glyf, loca = 5
		expect(numTables).toBe(5);
	});

	it('head.checksumAdjustment is patched in the output', () => {
		const { ttfOutput } = runCTFPipeline(stream0);

		// Find the head table in the output
		const numTables = (ttfOutput[4] << 8) | ttfOutput[5];
		let headOffset = -1;
		for (let i = 0; i < numTables; i++) {
			const dirOff = 12 + i * 16;
			const tag = String.fromCharCode(
				ttfOutput[dirOff],
				ttfOutput[dirOff + 1],
				ttfOutput[dirOff + 2],
				ttfOutput[dirOff + 3],
			);
			if (tag === 'head') {
				headOffset =
					((ttfOutput[dirOff + 8] << 24) |
						(ttfOutput[dirOff + 9] << 16) |
						(ttfOutput[dirOff + 10] << 8) |
						ttfOutput[dirOff + 11]) >>>
					0;
				break;
			}
		}

		expect(headOffset).toBeGreaterThan(0);
		// checksumAdjustment at offset 8 within head should NOT be all zeros
		const adj =
			((ttfOutput[headOffset + 8] << 24) |
				(ttfOutput[headOffset + 9] << 16) |
				(ttfOutput[headOffset + 10] << 8) |
				ttfOutput[headOffset + 11]) >>>
			0;
		expect(adj).not.toBe(0);
	});
});

describe('cTF integration — rectangle glyph (mixed triplet encodings)', () => {
	const { data: glyphData } = buildRectangleGlyphData();
	const head = buildHeadTable(0);
	const maxp = buildMaxpTable(1, 4, 1);
	const stream0 = buildCTFStream0({
		tables: [
			{ tag: 'head', data: head },
			{ tag: 'maxp', data: maxp },
		],
		glyphData,
	});

	it('parseCTF correctly decodes mixed X-only and Y-only triplets', () => {
		const { container } = runCTFPipeline(stream0);
		const glyf = container.tables.find((t) => t.tag === 'glyf')!;
		const s = new Stream(glyf.buf, glyf.bufSize);

		const numContours = s.readS16();
		expect(numContours).toBe(1);

		const xMin = s.readS16();
		const yMin = s.readS16();
		const xMax = s.readS16();
		const yMax = s.readS16();

		// Cumulative positions:
		// P0: (100, 0)
		// P1: (100, 200)
		// P2: (150, 200)
		// P3: (150, 300)
		expect(xMin).toBe(100);
		expect(yMin).toBe(0);
		expect(xMax).toBe(150);
		expect(yMax).toBe(300);
	});

	it('output has correct endPtsOfContours for 4 points', () => {
		const { container } = runCTFPipeline(stream0);
		const glyf = container.tables.find((t) => t.tag === 'glyf')!;
		const s = new Stream(glyf.buf, glyf.bufSize);

		s.seekRelative(10); // skip numContours + bbox
		const endPt0 = s.readU16();
		expect(endPt0).toBe(3); // 4 points → last index = 3
	});

	it('produces valid TrueType output', () => {
		const { ttfOutput } = runCTFPipeline(stream0);
		expect(ttfOutput.length).toBeGreaterThan(12);
		const sig = (ttfOutput[0] << 24) | (ttfOutput[1] << 16) | (ttfOutput[2] << 8) | ttfOutput[3];
		expect(sig >>> 0).toBe(0x00010000);
	});
});

describe('cTF integration — multiple glyphs', () => {
	const glyphData = buildMultiGlyphData();
	const head = buildHeadTable(1); // long loca format
	const maxp = buildMaxpTable(2, 3, 1);
	const stream0 = buildCTFStream0({
		tables: [
			{ tag: 'head', data: head },
			{ tag: 'maxp', data: maxp },
		],
		glyphData,
	});

	it('loca table has entries for 2 glyphs (long format)', () => {
		const { container } = runCTFPipeline(stream0);
		const loca = container.tables.find((t) => t.tag === 'loca')!;
		// Long loca: (numGlyphs + 1) × 4 bytes = (2 + 1) × 4 = 12 bytes
		expect(loca.bufSize).toBe(12);
	});

	it('loca entries are monotonically increasing', () => {
		const { container } = runCTFPipeline(stream0);
		const loca = container.tables.find((t) => t.tag === 'loca')!;
		const s = new Stream(loca.buf, loca.bufSize);

		const offsets: number[] = [];
		for (let i = 0; i < 3; i++) {
			offsets.push(s.readU32());
		}

		expect(offsets[0]).toBe(0);
		expect(offsets[1]).toBeGreaterThan(offsets[0]);
		expect(offsets[2]).toBeGreaterThan(offsets[1]);
	});

	it('glyf table has data for both glyphs', () => {
		const { container } = runCTFPipeline(stream0);
		const glyf = container.tables.find((t) => t.tag === 'glyf')!;
		const loca = container.tables.find((t) => t.tag === 'loca')!;
		const ls = new Stream(loca.buf, loca.bufSize);

		const offset0 = ls.readU32();
		const offset1 = ls.readU32();

		// Glyph 0 should start with numContours = 1
		const gs = new Stream(glyf.buf, glyf.bufSize);
		gs.seekAbsolute(offset0);
		expect(gs.readS16()).toBe(1); // glyph 0: simple, 1 contour

		// Glyph 1 should start with numContours = 1
		gs.seekAbsolute(offset1);
		expect(gs.readS16()).toBe(1); // glyph 1: simple, 1 contour
	});

	it('produces valid TrueType with correct table count', () => {
		const { ttfOutput } = runCTFPipeline(stream0);
		const numTables = (ttfOutput[4] << 8) | ttfOutput[5];
		expect(numTables).toBe(5); // head, maxp, hmtx, glyf, loca
	});
});

describe('cTF integration — composite glyph', () => {
	const glyphData = buildCompositeGlyphData();
	const head = buildHeadTable(0);
	const maxp = buildMaxpTable(2, 3, 1, 0, 1);
	const stream0 = buildCTFStream0({
		tables: [
			{ tag: 'head', data: head },
			{ tag: 'maxp', data: maxp },
		],
		glyphData,
	});

	it('correctly parses composite glyph following a simple glyph', () => {
		const { container } = runCTFPipeline(stream0);
		const glyf = container.tables.find((t) => t.tag === 'glyf')!;
		const loca = container.tables.find((t) => t.tag === 'loca')!;
		const ls = new Stream(loca.buf, loca.bufSize);

		const offset0 = ls.readU16() * 2; // short format: stored as offset/2
		const offset1 = ls.readU16() * 2;

		// Glyph 0: simple
		const gs = new Stream(glyf.buf, glyf.bufSize);
		gs.seekAbsolute(offset0);
		expect(gs.readS16()).toBe(1); // simple, 1 contour

		// Glyph 1: composite (numContours = -1)
		gs.seekAbsolute(offset1);
		expect(gs.readS16()).toBe(-1);
	});

	it('composite glyph has correct bounding box', () => {
		const { container } = runCTFPipeline(stream0);
		const glyf = container.tables.find((t) => t.tag === 'glyf')!;
		const loca = container.tables.find((t) => t.tag === 'loca')!;
		const ls = new Stream(loca.buf, loca.bufSize);

		ls.readU16(); // skip glyph 0 offset
		const offset1 = ls.readU16() * 2;

		const gs = new Stream(glyf.buf, glyf.bufSize);
		gs.seekAbsolute(offset1);
		gs.readS16(); // numContours = -1

		expect(gs.readS16()).toBe(0); // xMin
		expect(gs.readS16()).toBe(0); // yMin
		expect(gs.readS16()).toBe(100); // xMax
		expect(gs.readS16()).toBe(100); // yMax
	});
});

describe('cTF integration — explicit bbox glyph (0x7FFF)', () => {
	const glyphData = buildExplicitBboxGlyphData();
	const head = buildHeadTable(0);
	const maxp = buildMaxpTable(1, 2, 1);
	const stream0 = buildCTFStream0({
		tables: [
			{ tag: 'head', data: head },
			{ tag: 'maxp', data: maxp },
		],
		glyphData,
	});

	it('uses the explicit bbox values instead of computing from points', () => {
		const { container } = runCTFPipeline(stream0);
		const glyf = container.tables.find((t) => t.tag === 'glyf')!;
		const s = new Stream(glyf.buf, glyf.bufSize);

		const numContours = s.readS16();
		expect(numContours).toBe(1); // actual contour count (not 0x7FFF)

		// Explicit bbox should be preserved as-is
		expect(s.readS16()).toBe(10); // xMin
		expect(s.readS16()).toBe(20); // yMin
		expect(s.readS16()).toBe(200); // xMax
		expect(s.readS16()).toBe(300); // yMax
	});
});

describe('cTF integration — full TrueType validation', () => {
	const { data: glyphData } = buildTriangleGlyphData();
	const head = buildHeadTable(0);
	const maxp = buildMaxpTable(1, 3, 1);
	const stream0 = buildCTFStream0({
		tables: [
			{ tag: 'head', data: head },
			{ tag: 'maxp', data: maxp },
		],
		glyphData,
	});

	it('every table in the output directory has valid offset and size', () => {
		const { ttfOutput } = runCTFPipeline(stream0);
		const numTables = (ttfOutput[4] << 8) | ttfOutput[5];

		for (let i = 0; i < numTables; i++) {
			const dirOff = 12 + i * 16;
			const tag = String.fromCharCode(
				ttfOutput[dirOff],
				ttfOutput[dirOff + 1],
				ttfOutput[dirOff + 2],
				ttfOutput[dirOff + 3],
			);
			const offset =
				((ttfOutput[dirOff + 8] << 24) |
					(ttfOutput[dirOff + 9] << 16) |
					(ttfOutput[dirOff + 10] << 8) |
					ttfOutput[dirOff + 11]) >>>
				0;
			const size =
				((ttfOutput[dirOff + 12] << 24) |
					(ttfOutput[dirOff + 13] << 16) |
					(ttfOutput[dirOff + 14] << 8) |
					ttfOutput[dirOff + 15]) >>>
				0;

			expect(tag).toHaveLength(4);
			expect(offset).toBeGreaterThanOrEqual(12 + numTables * 16);
			expect(offset + size).toBeLessThanOrEqual(ttfOutput.length + 4); // allow padding
		}
	});

	it('head table magicNumber is preserved', () => {
		const { ttfOutput } = runCTFPipeline(stream0);
		const numTables = (ttfOutput[4] << 8) | ttfOutput[5];

		for (let i = 0; i < numTables; i++) {
			const dirOff = 12 + i * 16;
			const tag = String.fromCharCode(
				ttfOutput[dirOff],
				ttfOutput[dirOff + 1],
				ttfOutput[dirOff + 2],
				ttfOutput[dirOff + 3],
			);
			if (tag !== 'head') {
				continue;
			}

			const offset =
				((ttfOutput[dirOff + 8] << 24) |
					(ttfOutput[dirOff + 9] << 16) |
					(ttfOutput[dirOff + 10] << 8) |
					ttfOutput[dirOff + 11]) >>>
				0;

			// magicNumber at offset 12 within head
			const magic =
				((ttfOutput[offset + 12] << 24) |
					(ttfOutput[offset + 13] << 16) |
					(ttfOutput[offset + 14] << 8) |
					ttfOutput[offset + 15]) >>>
				0;
			expect(magic).toBe(0x5f0f3cf5);
		}
	});

	it('maxp.numGlyphs is preserved', () => {
		const { ttfOutput } = runCTFPipeline(stream0);
		const numTables = (ttfOutput[4] << 8) | ttfOutput[5];

		for (let i = 0; i < numTables; i++) {
			const dirOff = 12 + i * 16;
			const tag = String.fromCharCode(
				ttfOutput[dirOff],
				ttfOutput[dirOff + 1],
				ttfOutput[dirOff + 2],
				ttfOutput[dirOff + 3],
			);
			if (tag !== 'maxp') {
				continue;
			}

			const offset =
				((ttfOutput[dirOff + 8] << 24) |
					(ttfOutput[dirOff + 9] << 16) |
					(ttfOutput[dirOff + 10] << 8) |
					ttfOutput[dirOff + 11]) >>>
				0;

			// numGlyphs at offset 4 within maxp
			const numGlyphs = (ttfOutput[offset + 4] << 8) | ttfOutput[offset + 5];
			expect(numGlyphs).toBe(1);
		}
	});
});

describe('cTF integration — CVT table delta decoding', () => {
	it('decodes delta-encoded CVT entries correctly', () => {
		// Build a CVT table with delta encoding
		const cvtEncoded = new Stream(null, 0);
		cvtEncoded.reserve(64);

		// CVT format: U16 numEntries (count, not bytes), then delta-encoded
		// entries. Each entry decodes to one big-endian S16.
		cvtEncoded.writeU16(3);

		// Entry 0: literal 100 → lastValue = 100
		cvtEncoded.writeU8(100);
		// Entry 1: literal 50 → lastValue = 100 + 50 = 150
		cvtEncoded.writeU8(50);
		// Entry 2: code 238 + S16(-200) → lastValue = 150 + (-200) = -50
		cvtEncoded.writeU8(238);
		cvtEncoded.writeS16(-200);

		const cvtData = cvtEncoded.toUint8Array();

		// Build CTF stream with head, maxp, glyf, and cvt
		// The cvt table needs a specific offset in stream 0
		const head = buildHeadTable(0);
		const maxp = buildMaxpTable(1, 3, 1);
		const glyphData = buildTriangleGlyphData().data;

		// Build stream 0 with cvt table
		const stream0 = buildCTFStream0({
			tables: [
				{ tag: 'head', data: head },
				{ tag: 'maxp', data: maxp },
				{ tag: 'cvt ', data: cvtData },
			],
			glyphData,
		});

		const { container } = runCTFPipeline(stream0);
		const cvt = container.tables.find((t) => t.tag === 'cvt ')!;
		expect(cvt).toBeDefined();
		// 3 entries × 2 bytes each — a regression guard against the historical
		// bug where numEntries was misread as a byte count, halving the table.
		expect(cvt.bufSize).toBe(6);

		// Read the decoded CVT values (big-endian S16)
		const cs = new Stream(cvt.buf, cvt.bufSize);
		expect(cs.readS16()).toBe(100); // entry 0
		expect(cs.readS16()).toBe(150); // entry 1 (100 + 50)
		expect(cs.readS16()).toBe(-50); // entry 2 (150 - 200)
	});
});

describe('cTF integration — triplet encoding coverage', () => {
	it('handles all triplet encoding byte counts (2, 3, 4, 5)', () => {
		const s = new Stream(null, 0);
		s.reserve(256);

		s.writeS16(1); // numContours
		write255UShort(s, 3); // 4 points total = 1 + 3

		// Write ALL flag bytes first (CTF format)
		s.writeU8(23); // 2-byte encoding, on-curve (bit 7 = 0 per C ref: !(flag & 0x80))
		s.writeU8(87); // 3-byte encoding
		s.writeU8(123); // 4-byte encoding (idx 123 = 12-bit XY, xSign=1, ySign=1)
		s.writeU8(127); // 5-byte encoding (idx 127 = 16-bit XY, xSign=1, ySign=1)

		// Then ALL coordinate bytes
		s.writeU8(0x55); // point 0: 4-bit X + 4-bit Y
		s.writeU8(100);
		s.writeU8(50); // point 1: 8-bit X + 8-bit Y
		s.writeU8(0x12);
		s.writeU8(0x34);
		s.writeU8(0x56); // point 2: 12-bit X + 12-bit Y
		s.writeU8(0x01);
		s.writeU8(0x00);
		s.writeU8(0x02);
		s.writeU8(0x00); // point 3: 16-bit X + 16-bit Y

		write255UShort(s, 0);
		write255UShort(s, 0);

		const head = buildHeadTable(0);
		const maxp = buildMaxpTable(1, 4, 1);
		const stream0 = buildCTFStream0({
			tables: [
				{ tag: 'head', data: head },
				{ tag: 'maxp', data: maxp },
			],
			glyphData: s.toUint8Array(),
		});

		// Should not throw — if interleaving bug existed, this would crash
		const { container, ttfOutput } = runCTFPipeline(stream0);

		const glyf = container.tables.find((t) => t.tag === 'glyf')!;
		expect(glyf.bufSize).toBeGreaterThan(0);

		// Valid TrueType header
		const sig = (ttfOutput[0] << 24) | (ttfOutput[1] << 16) | (ttfOutput[2] << 8) | ttfOutput[3];
		expect(sig >>> 0).toBe(0x00010000);
	});
});

describe('decompressMtx — XOR decryption integration', () => {
	it('xOR decryption produces a copy without mutating input', () => {
		const input = new Uint8Array([0x50, 0x51, 0x52, 0x53, 0x54]);
		const inputCopy = input.slice();

		const result = decompressMtx(input, { compressed: false, encrypted: true });
		// Decrypted: each byte XOR 0x50
		expect(result[0]).toBe(0x00);
		expect(result[1]).toBe(0x01);
		expect(result[2]).toBe(0x02);
		expect(result[3]).toBe(0x03);
		expect(result[4]).toBe(0x04);

		// Original not mutated
		expect(input).toStrictEqual(inputCopy);
	});
});

describe('decompressEotFont — parameter delegation', () => {
	it('correctly passes compressed and encrypted flags', () => {
		const input = new Uint8Array([0x50, 0x51, 0x52]);

		// compressed=false, encrypted=true → XOR decrypt only
		const result = decompressEotFont(input, false, true);
		expect(result[0]).toBe(0x00);
		expect(result[1]).toBe(0x01);
		expect(result[2]).toBe(0x02);
	});
});

describe('triplet encoding table integrity', () => {
	it('has exactly 128 entries covering all 7-bit flag values', () => {
		expect(TRIPLET_ENCODINGS).toHaveLength(128);
	});

	it('every entry has valid byteCount (2-5)', () => {
		for (let i = 0; i < TRIPLET_ENCODINGS.length; i++) {
			const enc = TRIPLET_ENCODINGS[i];
			expect(enc.byteCount).toBeGreaterThanOrEqual(2);
			expect(enc.byteCount).toBeLessThanOrEqual(5);
		}
	});

	it('xBits + yBits fits within (byteCount - 1) * 8 bits', () => {
		for (let i = 0; i < TRIPLET_ENCODINGS.length; i++) {
			const enc = TRIPLET_ENCODINGS[i];
			const availableBits = (enc.byteCount - 1) * 8;
			expect(enc.xBits + enc.yBits).toBeLessThanOrEqual(availableBits);
		}
	});

	it('sign values are -1, 0, or 1', () => {
		for (const enc of TRIPLET_ENCODINGS) {
			expect([-1, 0, 1]).toContain(enc.xSign);
			expect([-1, 0, 1]).toContain(enc.ySign);
		}
	});
});
