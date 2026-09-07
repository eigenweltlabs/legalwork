/**
 * SFNT container assembly — builds a valid TrueType font file from an SFNTContainer.
 * Ported from libeot (MPL 2.0) — SFNTContainer.c
 */

import type { SFNTContainer, SFNTTable } from './ctf-parser';
import { EotError, EotErrorCode } from './errors';
import { Stream } from './stream';

// ---------------------------------------------------------------------------
// Helper math
// ---------------------------------------------------------------------------

/** Log2 of the largest power of 2 <= n. */
function lgFloor(n: number): number {
	let ret = 0;
	while (n > 1) {
		n = Math.floor(n / 2);
		ret++;
	}
	return ret;
}

/** Largest power of 2 <= n. */
function maxPow2(n: number): number {
	return 1 << lgFloor(n);
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * Write the 12-byte SFNT offset (header) table.
 *
 * Layout (all big-endian):
 *   scalarType   U32  — 0x00010000 for TrueType
 *   numTables    U16
 *   searchRange  U16
 *   entrySelector U16
 *   rangeShift   U16
 */
function writeOffsetTable(ctr: SFNTContainer, out: Stream): void {
	const numTables = ctr.tables.length;
	const searchRange = maxPow2(numTables) * 16;
	const entrySelector = lgFloor(numTables);
	const rangeShift = numTables * 16 - searchRange;

	out.writeU32(0x00010000); // scalarType
	out.writeU16(numTables);
	out.writeU16(searchRange);
	out.writeU16(entrySelector);
	out.writeU16(rangeShift);
}

/**
 * Write the table directory — one 16-byte record per table.
 *
 * Each record (big-endian):
 *   tag       4 bytes (ASCII)
 *   checksum  U32
 *   offset    U32
 *   bufSize   U32
 */
function writeTableDirectory(ctr: SFNTContainer, out: Stream): void {
	for (const table of ctr.tables) {
		// tag — 4 ASCII bytes
		out.writeU8(table.tag.charCodeAt(0));
		out.writeU8(table.tag.charCodeAt(1));
		out.writeU8(table.tag.charCodeAt(2));
		out.writeU8(table.tag.charCodeAt(3));
		out.writeU32(table.checksum);
		out.writeU32(table.offset);
		out.writeU32(table.bufSize);
	}
}

/**
 * Write table data to the output stream while computing its checksum.
 *
 * The data is treated as a sequence of big-endian U32 values.  If the
 * table size is not a multiple of 4 the final chunk is zero-padded.
 *
 * Side-effects: sets `table.offset` and `table.checksum`.
 */
function writeTableCheckingSum(table: SFNTTable, out: Stream): void {
	table.offset = out.pos;

	let checksum = 0;
	const data = table.buf;
	const len = table.bufSize;
	const fullWords = Math.floor(len / 4);
	const remainder = len % 4;

	for (let i = 0; i < fullWords; i++) {
		const off = i * 4;
		const word =
			((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]) >>> 0;
		checksum = (checksum + word) >>> 0;
		out.writeU32(word);
	}

	if (remainder > 0) {
		let word = 0;
		for (let j = 0; j < remainder; j++) {
			word |= data[fullWords * 4 + j] << (24 - j * 8);
		}
		word >>>= 0;
		checksum = (checksum + word) >>> 0;
		out.writeU32(word);
	}

	table.checksum = checksum;
}

// ---------------------------------------------------------------------------
// Size helpers
// ---------------------------------------------------------------------------

/** Size of the table directory: 16 bytes per table. */
function getTableDirectorySize(ctr: SFNTContainer): number {
	return 16 * ctr.tables.length;
}

/** Total bytes required for the assembled font. */
function getRequiredSize(ctr: SFNTContainer): number {
	const offsetTableSize = 12;
	const dirSize = getTableDirectorySize(ctr);
	let tableDataSize = 0;
	for (const table of ctr.tables) {
		// Each table's data is padded to a 4-byte boundary.
		tableDataSize += Math.ceil(table.bufSize / 4) * 4;
	}
	return offsetTableSize + dirSize + tableDataSize;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Assemble a complete TrueType font binary from an `SFNTContainer`.
 *
 * Steps:
 *  1. Compute required output size and allocate a `Stream`.
 *  2. Write the offset table (12 bytes).
 *  3. Reserve space for the table directory.
 *  4. Write each table's data, computing per-table checksums.
 *  5. Seek back and write the table directory.
 *  6. Compute whole-font checksum and patch the `head` table's
 *     `checksumAdjustment` field.
 *  7. Return the assembled bytes.
 */
export function dumpContainer(ctr: SFNTContainer): Uint8Array {
	const requiredSize = getRequiredSize(ctr);
	const out = new Stream(new Uint8Array(requiredSize), 0);

	// --- 1. Offset table ---------------------------------------------------
	writeOffsetTable(ctr, out);

	// --- 2. Remember where the directory goes, then skip past it -----------
	const dirOffset = out.pos;
	const dirSize = getTableDirectorySize(ctr);
	out.pos += dirSize;

	// --- 3. Write each table and accumulate checksums ----------------------
	let totalChecksum = 0;

	for (const table of ctr.tables) {
		writeTableCheckingSum(table, out);
		totalChecksum = (totalChecksum + table.checksum) >>> 0;
	}

	// --- 4. Find the "head" table ------------------------------------------
	let headTable: SFNTTable | undefined;
	for (const table of ctr.tables) {
		if (table.tag === 'head') {
			headTable = table;
			break;
		}
	}

	// --- 5. Seek back and write the table directory ------------------------
	const afterTables = out.pos;
	out.pos = dirOffset;
	writeTableDirectory(ctr, out);

	// --- 6. Compute checksum of the beginning (offset table + directory) ---
	const beginningLen = 12 + dirSize;
	let beginningChecksum = 0;
	const buf = out.buf;
	const beginningWords = Math.floor(beginningLen / 4);
	for (let i = 0; i < beginningWords; i++) {
		const off = i * 4;
		const word =
			((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
		beginningChecksum = (beginningChecksum + word) >>> 0;
	}

	totalChecksum = (totalChecksum + beginningChecksum) >>> 0;

	// --- 7. Patch head.checksumAdjustment (offset 8 within the head table) -
	// A valid SFNT always carries a `head` table (parseCTF enforces this), and
	// checksumAdjustment cannot be computed without it. Fail hard rather than
	// emitting a font whose whole-file checksum is silently left unpatched.
	if (!headTable) {
		throw new EotError(
			EotErrorCode.NoHeadTable,
			'cannot assemble SFNT: container is missing a head table',
		);
	}

	const finalChecksum = (0xb1b0afba - totalChecksum) >>> 0;

	const adjOffset = headTable.offset + 8;
	buf[adjOffset] = (finalChecksum >>> 24) & 0xff;
	buf[adjOffset + 1] = (finalChecksum >>> 16) & 0xff;
	buf[adjOffset + 2] = (finalChecksum >>> 8) & 0xff;
	buf[adjOffset + 3] = finalChecksum & 0xff;

	// Restore position to end
	out.pos = afterTables;

	return out.buf.subarray(0, out.pos);
}
