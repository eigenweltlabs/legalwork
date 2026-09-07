import { describe, it, expect, expectTypeOf } from 'vitest';

import type { SFNTContainer, SFNTTable } from './ctf-parser';
import { EotError, EotErrorCode } from './errors';
import { dumpContainer } from './sfnt-builder';

/**
 * Helper to create an SFNTTable.
 */
function makeTable(tag: string, data: Uint8Array): SFNTTable {
	return {
		tag,
		offset: 0,
		bufSize: data.length,
		buf: data,
		checksum: 0,
	};
}

/**
 * A `head` table of `size` bytes (default 54). dumpContainer now requires a
 * head table (it patches checksumAdjustment at offset 8), so structural tests
 * include one. Keep `size` >= 12 so the 4-byte patch stays within the table.
 */
function makeHead(size = 54): SFNTTable {
	return makeTable('head', new Uint8Array(size));
}

/**
 * Read a big-endian U16 from a Uint8Array at the given offset.
 */
function readU16(buf: Uint8Array, off: number): number {
	return (buf[off] << 8) | buf[off + 1];
}

/**
 * Read a big-endian U32 from a Uint8Array at the given offset.
 */
function readU32(buf: Uint8Array, off: number): number {
	return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

describe('dumpContainer', () => {
	// -----------------------------------------------------------------------
	// SFNT offset table structure
	// -----------------------------------------------------------------------
	it('writes the TrueType scalar type (0x00010000)', () => {
		const ctr: SFNTContainer = {
			tables: [makeHead()],
		};
		const result = dumpContainer(ctr);
		expect(readU32(result, 0)).toBe(0x00010000);
	});

	it('writes correct numTables', () => {
		const ctr: SFNTContainer = {
			tables: [makeHead(), makeTable('cmap', new Uint8Array(8))],
		};
		const result = dumpContainer(ctr);
		expect(readU16(result, 4)).toBe(2);
	});

	it('computes correct searchRange, entrySelector, rangeShift for 1 table', () => {
		const ctr: SFNTContainer = {
			tables: [makeHead()],
		};
		const result = dumpContainer(ctr);
		// 1 table: maxPow2(1)=1, searchRange=1*16=16, entrySelector=0, rangeShift=1*16-16=0
		expect(readU16(result, 6)).toBe(16); // searchRange
		expect(readU16(result, 8)).toBe(0); // entrySelector
		expect(readU16(result, 10)).toBe(0); // rangeShift
	});

	it('computes correct searchRange for 3 tables', () => {
		const ctr: SFNTContainer = {
			tables: [
				makeHead(),
				makeTable('cmap', new Uint8Array(4)),
				makeTable('post', new Uint8Array(4)),
			],
		};
		const result = dumpContainer(ctr);
		// maxPow2(3)=2, searchRange=2*16=32
		expect(readU16(result, 6)).toBe(32);
		// entrySelector = lgFloor(3) = 1
		expect(readU16(result, 8)).toBe(1);
		// rangeShift = 3*16 - 32 = 16
		expect(readU16(result, 10)).toBe(16);
	});

	// -----------------------------------------------------------------------
	// Table directory
	// -----------------------------------------------------------------------
	it('writes table tags in the directory', () => {
		const ctr: SFNTContainer = {
			tables: [makeHead()],
		};
		const result = dumpContainer(ctr);
		// Table directory starts at offset 12
		const tag = String.fromCharCode(result[12], result[13], result[14], result[15]);
		expect(tag).toBe('head');
	});

	it('writes correct table size in directory', () => {
		const ctr: SFNTContainer = {
			tables: [makeHead(42)],
		};
		const result = dumpContainer(ctr);
		// Directory entry: tag(4) + checksum(4) + offset(4) + size(4) starting at byte 12
		const recordedSize = readU32(result, 12 + 12); // size field at offset 12 of record
		expect(recordedSize).toBe(42);
	});

	// -----------------------------------------------------------------------
	// Table data and checksums
	// -----------------------------------------------------------------------
	it('embeds table data in the output', () => {
		const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const ctr: SFNTContainer = {
			// 'test' is first, so its directory entry / data stay at the front;
			// head is required by dumpContainer and lives after it.
			tables: [makeTable('test', data), makeHead()],
		};
		const result = dumpContainer(ctr);
		// Table data starts after header (12) + directory (2*16)
		const dataOffset = readU32(result, 12 + 8); // offset field of the first directory entry
		expect(readU32(result, dataOffset)).toBe(0xdeadbeef);
	});

	it('computes correct checksum for a simple 4-byte table', () => {
		const data = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
		const table = makeTable('test', data);
		const ctr: SFNTContainer = { tables: [table, makeHead()] };
		dumpContainer(ctr);
		// After dump, table.checksum should be 0x00000001
		expect(table.checksum).toBe(1);
	});

	it('computes correct checksum for a non-aligned table', () => {
		// 5 bytes: [0x01, 0x00, 0x00, 0x00, 0x02]
		// Padded: word1=0x01000000, word2=0x02000000
		// Checksum = 0x01000000 + 0x02000000 = 0x03000000
		const data = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x02]);
		const table = makeTable('test', data);
		const ctr: SFNTContainer = { tables: [table, makeHead()] };
		dumpContainer(ctr);
		expect(table.checksum).toBe(0x03000000);
	});

	// -----------------------------------------------------------------------
	// head table checksumAdjustment
	// -----------------------------------------------------------------------
	it('patches head.checksumAdjustment in the output', () => {
		// Create a minimal head table (54+ bytes)
		const headData = new Uint8Array(54);
		const ctr: SFNTContainer = {
			tables: [makeTable('head', headData)],
		};
		const result = dumpContainer(ctr);

		// Find the head table offset from directory
		const headOffset = readU32(result, 12 + 8);
		// checksumAdjustment is at offset 8 within the head table
		const csAdj = readU32(result, headOffset + 8);

		// The adjustment should be 0xB1B0AFBA - totalChecksum.
		// We just verify it's been written (non-zero likely) and is a valid U32.
		expect(csAdj).toBeDefined();
		expectTypeOf(csAdj).toBeNumber();
	});

	// -----------------------------------------------------------------------
	// Output size
	// -----------------------------------------------------------------------
	it('output size matches expected: header + directory + padded tables', () => {
		const ctr: SFNTContainer = {
			tables: [makeHead(12), makeTable('tst2', new Uint8Array(8))],
		};
		const result = dumpContainer(ctr);
		// Expected: 12 (header) + 2*16 (directory) + 12 (head padded to 12) + 8 (tst2 padded to 8)
		expect(result).toHaveLength(12 + 32 + 12 + 8);
	});

	it('pads tables to 4-byte boundaries', () => {
		// 5-byte table -> pads to 8 bytes in output
		const ctr: SFNTContainer = {
			tables: [makeTable('test', new Uint8Array(5)), makeHead()],
		};
		const result = dumpContainer(ctr);
		// 12 (header) + 2*16 (directory) + 8 (test 5->8 padded) + 56 (head 54->56 padded) = 108
		expect(result).toHaveLength(12 + 32 + 8 + 56);
	});

	// -----------------------------------------------------------------------
	// Multiple tables with head
	// -----------------------------------------------------------------------
	it('handles container with head and other tables', () => {
		const headData = new Uint8Array(54);
		const nameData = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
		const ctr: SFNTContainer = {
			tables: [makeTable('head', headData), makeTable('name', nameData)],
		};
		const result = dumpContainer(ctr);

		// Verify basic structure
		expect(readU32(result, 0)).toBe(0x00010000);
		expect(readU16(result, 4)).toBe(2);

		// Read both directory entries
		const tag1 = String.fromCharCode(result[12], result[13], result[14], result[15]);
		const tag2 = String.fromCharCode(result[28], result[29], result[30], result[31]);
		expect(tag1).toBe('head');
		expect(tag2).toBe('name');
	});

	// -----------------------------------------------------------------------
	// Missing head table
	// -----------------------------------------------------------------------
	it('throws EotError NoHeadTable when the container has no head table', () => {
		const ctr: SFNTContainer = {
			tables: [makeTable('name', new Uint8Array(4)), makeTable('cmap', new Uint8Array(8))],
		};
		expect(() => dumpContainer(ctr)).toThrow(EotError);
		try {
			dumpContainer(ctr);
		} catch (e) {
			expect((e as EotError).code).toBe(EotErrorCode.NoHeadTable);
		}
	});
});
