import { describe, it, expect } from 'vitest';

import { parseCTF } from './ctf-parser';
import { EotError, EotErrorCode } from './errors';
import { Stream } from './stream';

/** Minimal 54-byte `head` table (indexToLocFormat lives at offset 50). */
function minimalHead(): Uint8Array {
	return new Uint8Array(54);
}

/** Minimal 32-byte `maxp` v1.0 table with numGlyphs = 0. */
function minimalMaxp(): Uint8Array {
	const s = new Stream(null, 0);
	s.reserve(32);
	s.writeU32(0x00010000); // version 1.0
	for (let i = 0; i < 14; i++) {
		s.writeU16(0); // numGlyphs + the 13 v1.0 limit fields
	}
	return s.toUint8Array();
}

/**
 * Ensure the structural tables parseCTF requires (head, maxp, hmtx) are
 * present, injecting minimal versions for any the caller did not supply.
 */
function withRequiredTables(
	tables: { tag: string; data: Uint8Array }[],
): { tag: string; data: Uint8Array }[] {
	const have = new Set(tables.map((t) => t.tag));
	const result = [...tables];
	if (!have.has('head')) {
		result.push({ tag: 'head', data: minimalHead() });
	}
	if (!have.has('maxp')) {
		result.push({ tag: 'maxp', data: minimalMaxp() });
	}
	if (!have.has('hmtx')) {
		result.push({ tag: 'hmtx', data: new Uint8Array([0, 0, 0, 0]) });
	}
	return result;
}

/**
 * Build a minimal CTF stream[0] that contains an SFNT header and
 * table directory, plus the raw table data. The structural tables required
 * by parseCTF (head, maxp, hmtx) are injected automatically when absent.
 *
 * This is a helper for constructing test inputs for parseCTF.
 */
function buildMinimalCTFStream0(inputTables: { tag: string; data: Uint8Array }[]): Stream {
	return buildRawCTFStream0(withRequiredTables(inputTables));
}

/**
 * Build a CTF stream[0] from exactly the given tables, with no injection of
 * required structural tables. Use this to exercise the missing-table guards.
 */
function buildRawCTFStream0(tables: { tag: string; data: Uint8Array }[]): Stream {
	const s = new Stream(null, 0);

	// --- SFNT offset table (12 bytes) ---
	s.writeU32(0x00010000); // scalarType (TrueType)
	s.writeU16(tables.length); // numTables
	s.writeU16(0); // searchRange (not validated by parser)
	s.writeU16(0); // entrySelector
	s.writeU16(0); // rangeShift

	// The table directory follows immediately: 16 bytes per entry.
	// After the directory, we'll place each table's data.
	const dirEnd = 12 + tables.length * 16;
	let currentOffset = dirEnd;

	// --- Table directory entries ---
	for (const t of tables) {
		// 4-byte ASCII tag
		for (let i = 0; i < 4; i++) {
			s.writeU8(t.tag.charCodeAt(i));
		}
		s.writeU32(0); // checksum (skipped by parser)
		s.writeU32(currentOffset); // offset
		s.writeU32(t.data.length); // size
		currentOffset += t.data.length;
	}

	// --- Table data ---
	for (const t of tables) {
		for (let i = 0; i < t.data.length; i++) {
			s.writeU8(t.data[i]);
		}
	}

	s.seekAbsolute(0);
	return s;
}

describe('parseCTF', () => {
	// -----------------------------------------------------------------------
	// Minimal container with no glyf/loca
	// -----------------------------------------------------------------------
	it('parses a minimal CTF with a single table', () => {
		const tableData = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
		const s0 = buildMinimalCTFStream0([{ tag: 'name', data: tableData }]);
		const s1 = new Stream(new Uint8Array(0), 0);
		const s2 = new Stream(new Uint8Array(0), 0);

		const container = parseCTF([s0, s1, s2]);

		const name = container.tables.find((t) => t.tag === 'name')!;
		expect(name).toBeDefined();
		expect(name.bufSize).toBe(4);
		expect(name.buf).toStrictEqual(tableData);
	});

	it('parses multiple tables', () => {
		const tables = [
			{ tag: 'name', data: new Uint8Array([0x01, 0x02]) },
			{ tag: 'post', data: new Uint8Array([0x03, 0x04, 0x05]) },
			{ tag: 'OS/2', data: new Uint8Array([0x06]) },
		];
		const s0 = buildMinimalCTFStream0(tables);
		const s1 = new Stream(new Uint8Array(0), 0);
		const s2 = new Stream(new Uint8Array(0), 0);

		const container = parseCTF([s0, s1, s2]);

		expect(container.tables.find((t) => t.tag === 'name')).toBeDefined();
		expect(container.tables.find((t) => t.tag === 'post')).toBeDefined();
		expect(container.tables.find((t) => t.tag === 'OS/2')).toBeDefined();
	});

	// -----------------------------------------------------------------------
	// hdmx and VDMX table skipping
	// -----------------------------------------------------------------------
	it('skips hdmx tables', () => {
		const s0 = buildMinimalCTFStream0([
			{ tag: 'hdmx', data: new Uint8Array(50) },
			{ tag: 'name', data: new Uint8Array([0xaa, 0xbb]) },
		]);
		const warnings: string[] = [];
		const container = parseCTF([s0, new Stream(null, 0), new Stream(null, 0)], {
			onWarn: (m) => warnings.push(m),
		});

		// hdmx is dropped; name survives.
		expect(container.tables.find((t) => t.tag === 'hdmx')).toBeUndefined();
		const name = container.tables.find((t) => t.tag === 'name')!;
		expect(name).toBeDefined();
		expect(name.buf).toStrictEqual(new Uint8Array([0xaa, 0xbb]));

		// The drop is surfaced structurally and via the onWarn hook.
		expect(container.droppedTables).toEqual(['hdmx']);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('hdmx');
	});

	it('skips VDMX tables', () => {
		const s0 = buildMinimalCTFStream0([{ tag: 'VDMX', data: new Uint8Array(50) }]);
		const container = parseCTF([s0, new Stream(null, 0), new Stream(null, 0)]);
		expect(container.tables.find((t) => t.tag === 'VDMX')).toBeUndefined();
		expect(container.droppedTables).toEqual(['VDMX']);
	});

	it('omits droppedTables when nothing is dropped', () => {
		const s0 = buildMinimalCTFStream0([{ tag: 'name', data: new Uint8Array([0xaa, 0xbb]) }]);
		const container = parseCTF([s0, new Stream(null, 0), new Stream(null, 0)]);
		expect(container.droppedTables).toBeUndefined();
	});

	// -----------------------------------------------------------------------
	// head table zeroing of checksumAdjustment
	// -----------------------------------------------------------------------
	it('zeroes out bytes 8-11 of the head table', () => {
		// A minimal head table (54 bytes minimum for indexToLocFormat at offset 50)
		const headData = new Uint8Array(54);
		// Set bytes 8-11 to non-zero values
		headData[8] = 0xde;
		headData[9] = 0xad;
		headData[10] = 0xbe;
		headData[11] = 0xef;
		// Set indexToLocFormat at offset 50-51
		headData[50] = 0x00;
		headData[51] = 0x00;

		const s0 = buildMinimalCTFStream0([{ tag: 'head', data: headData }]);
		const container = parseCTF([s0, new Stream(null, 0), new Stream(null, 0)]);

		const head = container.tables.find((t) => t.tag === 'head')!;
		expect(head).toBeDefined();
		// checksumAdjustment (bytes 8-11) should be zeroed
		expect(head.buf[8]).toBe(0);
		expect(head.buf[9]).toBe(0);
		expect(head.buf[10]).toBe(0);
		expect(head.buf[11]).toBe(0);
	});

	// -----------------------------------------------------------------------
	// Container type
	// -----------------------------------------------------------------------
	it('returns an SFNTContainer with a tables array', () => {
		const s0 = buildMinimalCTFStream0([{ tag: 'cmap', data: new Uint8Array(10) }]);
		const container = parseCTF([s0, new Stream(null, 0), new Stream(null, 0)]);
		expect(container).toHaveProperty('tables');
		expect(Array.isArray(container.tables)).toBeTruthy();
	});

	// -----------------------------------------------------------------------
	// Empty container
	// -----------------------------------------------------------------------
	it('rejects a container with zero tables (no required tables present)', () => {
		const s = new Stream(null, 0);
		s.writeU32(0x00010000);
		s.writeU16(0); // 0 tables
		s.writeU16(0);
		s.writeU16(0);
		s.writeU16(0);
		s.seekAbsolute(0);

		// A font with no tables is missing maxp/head/hmtx — parseCTF must reject
		// it rather than return an empty container.
		expect(() => parseCTF([s, new Stream(null, 0), new Stream(null, 0)])).toThrow(
			/missing a maxp table/,
		);
	});

	// -----------------------------------------------------------------------
	// Table data integrity
	// -----------------------------------------------------------------------
	it('preserves exact table data bytes', () => {
		const data = new Uint8Array(256);
		for (let i = 0; i < 256; i++) {
			data[i] = i;
		}

		const s0 = buildMinimalCTFStream0([{ tag: 'cmap', data }]);
		const container = parseCTF([s0, new Stream(null, 0), new Stream(null, 0)]);

		const cmap = container.tables.find((t) => t.tag === 'cmap')!;
		expect(cmap).toBeDefined();
		expect(cmap.bufSize).toBe(256);
		for (let i = 0; i < 256; i++) {
			expect(cmap.buf[i]).toBe(i);
		}
	});

	// -----------------------------------------------------------------------
	// Structural validity guards (ported from libeot parseCTF.c)
	// -----------------------------------------------------------------------
	const empty = () => new Stream(null, 0);

	it('throws EotError NoMaxpTable when maxp is absent', () => {
		// head + hmtx present, maxp deliberately omitted (raw builder — no injection).
		const s0 = buildRawCTFStream0([
			{ tag: 'head', data: minimalHead() },
			{ tag: 'hmtx', data: new Uint8Array([0, 0, 0, 0]) },
		]);
		try {
			parseCTF([s0, empty(), empty()]);
			expect.fail('expected parseCTF to throw for missing maxp');
		} catch (e) {
			expect(e).toBeInstanceOf(EotError);
			expect((e as EotError).code).toBe(EotErrorCode.NoMaxpTable);
		}
	});

	it('throws EotError NoHmtxTable when hmtx is absent', () => {
		const s0 = buildRawCTFStream0([
			{ tag: 'head', data: minimalHead() },
			{ tag: 'maxp', data: minimalMaxp() },
		]);
		try {
			parseCTF([s0, empty(), empty()]);
			expect.fail('expected parseCTF to throw for missing hmtx');
		} catch (e) {
			expect(e).toBeInstanceOf(EotError);
			expect((e as EotError).code).toBe(EotErrorCode.NoHmtxTable);
		}
	});

	it('throws EotError MalformedHeadTable for a head table shorter than 12 bytes', () => {
		const s0 = buildRawCTFStream0([
			{ tag: 'head', data: new Uint8Array(8) },
			{ tag: 'maxp', data: minimalMaxp() },
			{ tag: 'hmtx', data: new Uint8Array([0, 0, 0, 0]) },
		]);
		try {
			parseCTF([s0, empty(), empty()]);
			expect.fail('expected parseCTF to throw for a short head table');
		} catch (e) {
			expect(e).toBeInstanceOf(EotError);
			expect((e as EotError).code).toBe(EotErrorCode.MalformedHeadTable);
		}
	});
});
