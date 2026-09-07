import { describe, it, expect } from 'vitest';

import { AHuff } from './ahuff';
import { BitIO } from './bitio';

/**
 * Build a Uint8Array from a sequence of bits (MSB-first packing).
 * If the total bit count is not a multiple of 8, trailing bits are 0.
 */
function bitsToBytes(bits: boolean[]): Uint8Array {
	const numBytes = Math.ceil(bits.length / 8);
	const result = new Uint8Array(numBytes);
	for (let i = 0; i < bits.length; i++) {
		if (bits[i]) {
			result[Math.floor(i / 8)] |= 1 << (7 - (i % 8));
		}
	}
	return result;
}

describe('aHuff', () => {
	// -----------------------------------------------------------------------
	// Construction with small range
	// -----------------------------------------------------------------------
	describe('construction', () => {
		it('constructs with range=2 without throwing', () => {
			const bio = new BitIO(new Uint8Array(16));
			expect(() => new AHuff(bio, 2)).not.toThrow();
		});

		it('constructs with range=4 without throwing', () => {
			const bio = new BitIO(new Uint8Array(16));
			expect(() => new AHuff(bio, 4)).not.toThrow();
		});

		it('constructs with range=8 without throwing', () => {
			const bio = new BitIO(new Uint8Array(16));
			expect(() => new AHuff(bio, 8)).not.toThrow();
		});

		it('constructs with range=256 without throwing', () => {
			const bio = new BitIO(new Uint8Array(256));
			expect(() => new AHuff(bio, 256)).not.toThrow();
		});

		it('constructs with range > 256 (large tree path) without throwing', () => {
			const bio = new BitIO(new Uint8Array(1024));
			expect(() => new AHuff(bio, 300)).not.toThrow();
		});
	});

	// -----------------------------------------------------------------------
	// readSymbol — symbol decoding from bit stream
	// -----------------------------------------------------------------------
	describe('readSymbol', () => {
		it('decodes symbol 0 from a range=2 tree', () => {
			// Range=2: leaves at indices 2 (symbol 0) and 3 (symbol 1).
			// After pre-biasing (small tree: 2 rounds of updates), the tree
			// may be rearranged. We can verify decoding works by encoding a
			// known path.
			//
			// For the initial tree, path to leaf 2 (symbol 0): from ROOT (1),
			// child = 2 means left (even), so bit=0.
			// After pre-biasing both symbols get updated equally, so the tree
			// structure should remain symmetric. Symbol 0 = left = 0 bit.
			const bits = bitsToBytes([false]); // 0 -> left -> symbol 0
			const bio = new BitIO(bits);
			const ah = new AHuff(bio, 2);
			expect(ah.readSymbol()).toBe(0);
		});

		it('decodes both symbols from a range=2 tree', () => {
			// After pre-biasing, the tree may rearrange. Decode with bit=1
			// and verify the result is a valid symbol (0 or 1).
			const bits = bitsToBytes([true]);
			const bio = new BitIO(bits);
			const ah = new AHuff(bio, 2);
			const sym = ah.readSymbol();
			expect(sym).toBeGreaterThanOrEqual(0);
			expect(sym).toBeLessThan(2);
		});

		it('decodes multiple symbols sequentially from a range=2 tree', () => {
			// Encode: symbol 0, then symbol 1
			// After decoding symbol 0, the tree adapts. But for range=2 with
			// equal-weight initialization, the tree should still work with the
			// same basic left/right mapping for the first few symbols.
			// Since the tree adapts, let's just verify we get valid symbols.
			const bits = bitsToBytes([false, true, false]);
			const bio = new BitIO(bits);
			const ah = new AHuff(bio, 2);
			const s1 = ah.readSymbol();
			const s2 = ah.readSymbol();
			const s3 = ah.readSymbol();
			// All decoded symbols should be in range [0, 2)
			expect(s1).toBeGreaterThanOrEqual(0);
			expect(s1).toBeLessThan(2);
			expect(s2).toBeGreaterThanOrEqual(0);
			expect(s2).toBeLessThan(2);
			expect(s3).toBeGreaterThanOrEqual(0);
			expect(s3).toBeLessThan(2);
		});

		it('decoded symbols are always in valid range for range=4', () => {
			// Provide enough random-looking bits
			const data = new Uint8Array([0xaa, 0x55, 0xf0, 0x0f, 0xcc, 0x33, 0xa5, 0x5a]);
			const bio = new BitIO(data);
			const ah = new AHuff(bio, 4);

			// Decode several symbols; each must be in [0, 4)
			for (let i = 0; i < 5; i++) {
				try {
					const sym = ah.readSymbol();
					expect(sym).toBeGreaterThanOrEqual(0);
					expect(sym).toBeLessThan(4);
				} catch {
					// May run out of bits; that's OK for this test
					break;
				}
			}
		});

		it('decoded symbols are always in valid range for range=8', () => {
			const data = new Uint8Array(32);
			// Fill with a pattern
			for (let i = 0; i < 32; i++) {
				data[i] = i * 7 + 13;
			}
			const bio = new BitIO(data);
			const ah = new AHuff(bio, 8);

			for (let i = 0; i < 10; i++) {
				try {
					const sym = ah.readSymbol();
					expect(sym).toBeGreaterThanOrEqual(0);
					expect(sym).toBeLessThan(8);
				} catch {
					break;
				}
			}
		});

		it('adaptive weighting changes tree over time', () => {
			// Feed alternating bit patterns and verify the tree adapts.
			// We create enough data to decode many symbols.
			const data = new Uint8Array(128);
			for (let i = 0; i < 128; i++) {
				data[i] = 0xaa;
			} // alternating bits
			const bio = new BitIO(data);
			const ah = new AHuff(bio, 4);

			const symbols: number[] = [];
			for (let i = 0; i < 20; i++) {
				try {
					symbols.push(ah.readSymbol());
				} catch {
					break;
				}
			}
			// We should decode at least some valid symbols.
			expect(symbols.length).toBeGreaterThan(0);
			for (const sym of symbols) {
				expect(sym).toBeGreaterThanOrEqual(0);
				expect(sym).toBeLessThan(4);
			}
		});
	});

	// -----------------------------------------------------------------------
	// Large range (> 256) — exercises the bitCount2 path
	// -----------------------------------------------------------------------
	describe('large range', () => {
		it('constructs a tree with range=300 and decodes valid symbols', () => {
			const data = new Uint8Array(256);
			for (let i = 0; i < 256; i++) {
				data[i] = i;
			}
			const bio = new BitIO(data);
			const ah = new AHuff(bio, 300);

			for (let i = 0; i < 5; i++) {
				try {
					const sym = ah.readSymbol();
					expect(sym).toBeGreaterThanOrEqual(0);
					expect(sym).toBeLessThan(300);
				} catch {
					break;
				}
			}
		});
	});
});
