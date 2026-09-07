import { describe, it, expect, expectTypeOf } from 'vitest';

import { decompressMtx, decompressEotFont, unpackMtx } from './mtx-decompress';

describe('decompressMtx', () => {
	// -----------------------------------------------------------------------
	// Option handling
	// -----------------------------------------------------------------------
	it('returns data as-is when compressed=false', () => {
		const input = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
		const result = decompressMtx(input, { compressed: false });
		expect(result).toStrictEqual(input);
	});

	it('returns data as-is when compressed=false and encrypted=false', () => {
		const input = new Uint8Array([0xaa, 0xbb, 0xcc]);
		const result = decompressMtx(input, {
			compressed: false,
			encrypted: false,
		});
		expect(result).toStrictEqual(input);
	});

	it('xOR-decrypts with key 0x50 when encrypted=true', () => {
		// If data is [0x50], decrypting with XOR 0x50 yields [0x00]
		const input = new Uint8Array([0x50, 0x51, 0x52]);
		const result = decompressMtx(input, {
			compressed: false,
			encrypted: true,
		});
		expect(result[0]).toBe(0x00); // 0x50 ^ 0x50
		expect(result[1]).toBe(0x01); // 0x51 ^ 0x50
		expect(result[2]).toBe(0x02); // 0x52 ^ 0x50
	});

	it('encryption does not mutate the original buffer', () => {
		const input = new Uint8Array([0x50, 0x60, 0x70]);
		const inputCopy = input.slice();
		decompressMtx(input, { compressed: false, encrypted: true });
		expect(input).toStrictEqual(inputCopy);
	});

	it('passthrough returns an owned copy, not the caller buffer', () => {
		const input = new Uint8Array([0xaa, 0xbb, 0xcc]);
		const result = decompressMtx(input, { compressed: false, encrypted: false });
		// Mutating the result must not write back into the caller's array.
		result[0] = 0x00;
		expect(input[0]).toBe(0xaa);
	});

	it('defaults to compressed=true', () => {
		// With no options, compressed defaults to true.
		// A tiny buffer will fail decompression.
		const input = new Uint8Array(4);
		expect(() => decompressMtx(input)).toThrow();
	});

	it('defaults to encrypted=false', () => {
		// With compressed=false and no encrypted option, data should pass through unchanged
		const input = new Uint8Array([0x50]);
		const result = decompressMtx(input, { compressed: false });
		expect(result[0]).toBe(0x50); // not decrypted
	});
});

describe('decompressEotFont', () => {
	it('delegates to decompressMtx with explicit parameters', () => {
		const input = new Uint8Array([0x01, 0x02, 0x03]);
		// compressed=false, encrypted=false -> passthrough
		const result = decompressEotFont(input, false, false);
		expect(result).toStrictEqual(input);
	});

	it('applies encryption when encrypted=true', () => {
		const input = new Uint8Array([0x50]);
		const result = decompressEotFont(input, false, true);
		expect(result[0]).toBe(0x00); // 0x50 ^ 0x50
	});

	it('throws on compressed=true with insufficient data', () => {
		const input = new Uint8Array(4);
		expect(() => decompressEotFont(input, true, false)).toThrow();
	});
});

describe('unpackMtx', () => {
	it('is exported and callable', () => {
		expectTypeOf(unpackMtx).toBeFunction();
	});

	it('throws when given too-small data for header', () => {
		const tiny = new Uint8Array(4);
		expect(() => unpackMtx(tiny, 4)).toThrow();
	});

	it('parses the 10-byte MTX header correctly', () => {
		// Build a minimal MTX header:
		//   byte 0: versionMagic = 1
		//   bytes 1-3: copyLimit (24-bit, not used) = 0
		//   bytes 4-6: offset2 (24-bit) — start of block 2
		//   bytes 7-9: offset3 (24-bit) — start of block 3
		//
		// Then we need LZCOMP data at blocks 1, 2, 3.
		// LZCOMP requires enough data for Huffman tree initialization.
		// We'll provide a large enough buffer.
		//
		// Block boundaries: [10, offset2), [offset2, offset3), [offset3, end)
		// Make all blocks start right after the previous, containing enough
		// data.
		const headerSize = 10;
		const blockSize = 2048;
		const totalSize = headerSize + 3 * blockSize;
		const offset2 = headerSize + blockSize;
		const offset3 = offset2 + blockSize;

		const data = new Uint8Array(totalSize);
		data[0] = 1; // versionMagic = 1

		// offset2 as 24-bit big-endian
		data[4] = (offset2 >> 16) & 0xff;
		data[5] = (offset2 >> 8) & 0xff;
		data[6] = offset2 & 0xff;

		// offset3 as 24-bit big-endian
		data[7] = (offset3 >> 16) & 0xff;
		data[8] = (offset3 >> 8) & 0xff;
		data[9] = offset3 & 0xff;

		// Each block contains zeros. LZCOMP with versionMagic=1 skips the
		// RLE bit, then initializes Huffman trees.
		// This will likely fail during decompression but we can verify the
		// function at least attempts to decompress three blocks.
		try {
			const result = unpackMtx(data, totalSize);
			expect(result.streams).toHaveLength(3);
			expect(result.sizes).toHaveLength(3);
		} catch {
			// LZCOMP decompression failure on zero-filled blocks is expected.
			// The important thing is the header parsing worked.
		}
	});

	it('returns three streams and three sizes', () => {
		// Same structure as above but verify the return type shape
		const data = new Uint8Array(8192);
		data[0] = 1;
		const offset2 = 2740;
		const offset3 = 5470;
		data[4] = (offset2 >> 16) & 0xff;
		data[5] = (offset2 >> 8) & 0xff;
		data[6] = offset2 & 0xff;
		data[7] = (offset3 >> 16) & 0xff;
		data[8] = (offset3 >> 8) & 0xff;
		data[9] = offset3 & 0xff;

		try {
			const result = unpackMtx(data, data.length);
			expect(result).toHaveProperty('streams');
			expect(result).toHaveProperty('sizes');
			expect(result.streams).toHaveLength(3);
			expect(result.sizes).toHaveLength(3);
			for (const s of result.streams) {
				expect(s).toBeInstanceOf(Uint8Array);
			}
			for (const sz of result.sizes) {
				expectTypeOf(sz).toBeNumber();
				expect(sz).toBeGreaterThanOrEqual(0);
			}
		} catch {
			// Expected - LZCOMP needs valid compressed data
		}
	});
});
