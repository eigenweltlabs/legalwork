import { describe, it, expect } from 'vitest';

import { BitIO } from './bitio';

describe('bitIO', () => {
	// -----------------------------------------------------------------------
	// inputBit — single bit reads, MSB first
	// -----------------------------------------------------------------------
	describe('inputBit', () => {
		it('reads bits MSB first from a single byte', () => {
			// 0b10110100 = 0xB4
			const bio = new BitIO(new Uint8Array([0xb4]));
			const bits: boolean[] = [];
			for (let i = 0; i < 8; i++) {
				bits.push(bio.inputBit());
			}
			// MSB first: 1,0,1,1,0,1,0,0
			expect(bits).toStrictEqual([true, false, true, true, false, true, false, false]);
		});

		it('reads across byte boundaries', () => {
			// 0xFF = 11111111, 0x00 = 00000000
			const bio = new BitIO(new Uint8Array([0xff, 0x00]));
			for (let i = 0; i < 8; i++) {
				expect(bio.inputBit()).toBeTruthy();
			}
			for (let i = 0; i < 8; i++) {
				expect(bio.inputBit()).toBeFalsy();
			}
		});

		it('throws on reading past end of data', () => {
			const bio = new BitIO(new Uint8Array([0xff]));
			// Read all 8 bits
			for (let i = 0; i < 8; i++) {
				bio.inputBit();
			}
			expect(() => bio.inputBit()).toThrow('end of data');
		});

		it('handles offset into buffer', () => {
			// buf = [0x00, 0xFF], offset=1 -> starts reading from 0xFF
			const bio = new BitIO(new Uint8Array([0x00, 0xff]), 1);
			for (let i = 0; i < 8; i++) {
				expect(bio.inputBit()).toBeTruthy();
			}
		});

		it('handles custom size parameter', () => {
			// buf has 3 bytes, but size=2, so only 2 are accessible
			const bio = new BitIO(new Uint8Array([0xff, 0x00, 0xaa]), 0, 2);
			// Can read 16 bits (2 bytes)
			for (let i = 0; i < 16; i++) {
				bio.inputBit();
			}
			// 17th bit should throw
			expect(() => bio.inputBit()).toThrow('end of data');
		});

		it('throws rather than yielding zero bits when size exceeds the buffer', () => {
			// size claims 4 bytes but only 1 is present. The extra length must be
			// clamped so reads past the real end throw instead of silently
			// returning 0 bits (which would corrupt a decode).
			const bio = new BitIO(new Uint8Array([0xff]), 0, 4);
			for (let i = 0; i < 8; i++) {
				expect(bio.inputBit()).toBeTruthy();
			}
			expect(() => bio.inputBit()).toThrow('end of data');
		});

		it('stays consistent after a caught end-of-data error', () => {
			const bio = new BitIO(new Uint8Array([0xff]));
			for (let i = 0; i < 8; i++) {
				bio.inputBit();
			}
			expect(() => bio.inputBit()).toThrow('end of data');
			// A retry must throw again, not return a stale/garbage bit.
			expect(() => bio.inputBit()).toThrow('end of data');
		});
	});

	// -----------------------------------------------------------------------
	// readValue — multi-bit unsigned integer reads
	// -----------------------------------------------------------------------
	describe('readValue', () => {
		it('reads 0 bits and returns 0', () => {
			const bio = new BitIO(new Uint8Array([0xff]));
			expect(bio.readValue(0)).toBe(0);
		});

		it('reads a full 8-bit value', () => {
			const bio = new BitIO(new Uint8Array([0xab]));
			expect(bio.readValue(8)).toBe(0xab);
		});

		it('reads a 4-bit value (high nibble)', () => {
			// 0xF3 = 1111 0011
			const bio = new BitIO(new Uint8Array([0xf3]));
			expect(bio.readValue(4)).toBe(0x0f);
		});

		it('reads a 3-bit value', () => {
			// 0b10100000 = 0xA0
			// first 3 bits MSB = 1,0,1 -> value built as:
			//   iter i=2: value=0, shift left, bit=1 -> value=1
			//   iter i=1: value=1, shift left -> 2, bit=0 -> value=2
			//   iter i=0: value=2, shift left -> 4, bit=1 -> value=5
			const bio = new BitIO(new Uint8Array([0xa0]));
			expect(bio.readValue(3)).toBe(5);
		});

		it('reads a 16-bit value spanning two bytes', () => {
			const bio = new BitIO(new Uint8Array([0x12, 0x34]));
			expect(bio.readValue(16)).toBe(0x1234);
		});

		it('returns an unsigned result for a full 32-bit read', () => {
			const bio = new BitIO(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
			// Must be 4294967295, not -1 (JS left-shift is signed).
			expect(bio.readValue(32)).toBe(0xffffffff);
		});

		it('reads multiple values sequentially', () => {
			// 0b11001010 = 0xCA
			const bio = new BitIO(new Uint8Array([0xca]));
			// Read 2 bits: 11 -> 3
			expect(bio.readValue(2)).toBe(3);
			// Read 3 bits: 001 -> 1
			expect(bio.readValue(3)).toBe(1);
			// Read 3 bits: 010 -> 2
			expect(bio.readValue(3)).toBe(2);
		});

		it('reads a 24-bit value spanning three bytes', () => {
			const bio = new BitIO(new Uint8Array([0xab, 0xcd, 0xef]));
			expect(bio.readValue(24)).toBe(0xabcdef);
		});

		it('reads 1-bit values correctly', () => {
			// 0b10000000 = 0x80
			const bio = new BitIO(new Uint8Array([0x80]));
			expect(bio.readValue(1)).toBe(1);
			expect(bio.readValue(1)).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// Edge cases
	// -----------------------------------------------------------------------
	describe('edge cases', () => {
		it('works with a single zero byte', () => {
			const bio = new BitIO(new Uint8Array([0x00]));
			expect(bio.readValue(8)).toBe(0);
		});

		it('works with alternating bit pattern', () => {
			// 0b10101010 = 0xAA
			const bio = new BitIO(new Uint8Array([0xaa]));
			for (let i = 0; i < 4; i++) {
				expect(bio.inputBit()).toBeTruthy();
				expect(bio.inputBit()).toBeFalsy();
			}
		});

		it('offset + size restricts readable range', () => {
			const buf = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44]);
			const bio = new BitIO(buf, 1, 3); // only bytes at indices 1,2 accessible (size=3 means indices up to 2)
			expect(bio.readValue(8)).toBe(0x11);
			expect(bio.readValue(8)).toBe(0x22);
			// Next byte would be at index 3 which equals size, should throw
			expect(() => bio.readValue(8)).toThrow('end of data');
		});

		it('interleaving inputBit and readValue works correctly', () => {
			// 0b11001100 = 0xCC
			const bio = new BitIO(new Uint8Array([0xcc]));
			// Read 1 bit: 1
			expect(bio.inputBit()).toBeTruthy();
			// Read 3 bits: 100 -> 4
			expect(bio.readValue(3)).toBe(4);
			// Read 4 bits: 1100 -> 12
			expect(bio.readValue(4)).toBe(12);
		});
	});
});
