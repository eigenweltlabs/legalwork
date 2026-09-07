import { describe, it, expect } from 'vitest';

import { TRIPLET_ENCODINGS } from './triplet-encodings';

describe('tRIPLET_ENCODINGS', () => {
	// -----------------------------------------------------------------------
	// Table structure
	// -----------------------------------------------------------------------
	it('contains 128 entries (indices 0-127)', () => {
		expect(TRIPLET_ENCODINGS).toHaveLength(128);
	});

	it('every entry has the required fields', () => {
		for (const enc of TRIPLET_ENCODINGS) {
			expect(enc).toHaveProperty('byteCount');
			expect(enc).toHaveProperty('xBits');
			expect(enc).toHaveProperty('yBits');
			expect(enc).toHaveProperty('deltaX');
			expect(enc).toHaveProperty('deltaY');
			expect(enc).toHaveProperty('xSign');
			expect(enc).toHaveProperty('ySign');
		}
	});

	it('byteCount is always 2, 3, 4, or 5', () => {
		const validCounts = new Set([2, 3, 4, 5]);
		for (const enc of TRIPLET_ENCODINGS) {
			expect(validCounts.has(enc.byteCount)).toBeTruthy();
		}
	});

	it('xSign is always -1, 0, or 1', () => {
		for (const enc of TRIPLET_ENCODINGS) {
			expect([-1, 0, 1]).toContain(enc.xSign);
		}
	});

	it('ySign is always -1, 0, or 1', () => {
		for (const enc of TRIPLET_ENCODINGS) {
			expect([-1, 0, 1]).toContain(enc.ySign);
		}
	});

	// -----------------------------------------------------------------------
	// Y-axis-only entries (indices 0-9)
	// -----------------------------------------------------------------------
	describe('indices 0-9 (Y-axis only)', () => {
		it('have xBits=0 and yBits=8', () => {
			for (let i = 0; i <= 9; i++) {
				expect(TRIPLET_ENCODINGS[i].xBits).toBe(0);
				expect(TRIPLET_ENCODINGS[i].yBits).toBe(8);
			}
		});

		it('have byteCount=2', () => {
			for (let i = 0; i <= 9; i++) {
				expect(TRIPLET_ENCODINGS[i].byteCount).toBe(2);
			}
		});

		it('have xSign=0 (no X movement)', () => {
			for (let i = 0; i <= 9; i++) {
				expect(TRIPLET_ENCODINGS[i].xSign).toBe(0);
			}
		});

		it('alternate ySign between -1 and 1', () => {
			for (let i = 0; i <= 9; i++) {
				const expectedSign = i % 2 === 0 ? -1 : 1;
				expect(TRIPLET_ENCODINGS[i].ySign).toBe(expectedSign);
			}
		});

		it('deltaY increases by 256 every pair', () => {
			const expectedDeltaY = [0, 0, 256, 256, 512, 512, 768, 768, 1024, 1024];
			for (let i = 0; i <= 9; i++) {
				expect(TRIPLET_ENCODINGS[i].deltaY).toBe(expectedDeltaY[i]);
			}
		});
	});

	// -----------------------------------------------------------------------
	// X-axis-only entries (indices 10-19)
	// -----------------------------------------------------------------------
	describe('indices 10-19 (X-axis only)', () => {
		it('have xBits=8 and yBits=0', () => {
			for (let i = 10; i <= 19; i++) {
				expect(TRIPLET_ENCODINGS[i].xBits).toBe(8);
				expect(TRIPLET_ENCODINGS[i].yBits).toBe(0);
			}
		});

		it('have byteCount=2', () => {
			for (let i = 10; i <= 19; i++) {
				expect(TRIPLET_ENCODINGS[i].byteCount).toBe(2);
			}
		});

		it('have ySign=0 (no Y movement)', () => {
			for (let i = 10; i <= 19; i++) {
				expect(TRIPLET_ENCODINGS[i].ySign).toBe(0);
			}
		});

		it('alternate xSign between -1 and 1', () => {
			for (let i = 10; i <= 19; i++) {
				const expectedSign = i % 2 === 0 ? -1 : 1;
				expect(TRIPLET_ENCODINGS[i].xSign).toBe(expectedSign);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 4-bit X + 4-bit Y entries (indices 20-83)
	// -----------------------------------------------------------------------
	describe('indices 20-83 (4+4 bits)', () => {
		it('all have byteCount=2, xBits=4, yBits=4', () => {
			for (let i = 20; i <= 83; i++) {
				expect(TRIPLET_ENCODINGS[i].byteCount).toBe(2);
				expect(TRIPLET_ENCODINGS[i].xBits).toBe(4);
				expect(TRIPLET_ENCODINGS[i].yBits).toBe(4);
			}
		});

		it('signs cover all four combinations (-1,-1), (1,-1), (-1,1), (1,1)', () => {
			// Each group of 4 consecutive entries cycles through sign combinations
			for (let base = 20; base <= 80; base += 4) {
				expect(TRIPLET_ENCODINGS[base].xSign).toBe(-1);
				expect(TRIPLET_ENCODINGS[base].ySign).toBe(-1);
				expect(TRIPLET_ENCODINGS[base + 1].xSign).toBe(1);
				expect(TRIPLET_ENCODINGS[base + 1].ySign).toBe(-1);
				expect(TRIPLET_ENCODINGS[base + 2].xSign).toBe(-1);
				expect(TRIPLET_ENCODINGS[base + 2].ySign).toBe(1);
				expect(TRIPLET_ENCODINGS[base + 3].xSign).toBe(1);
				expect(TRIPLET_ENCODINGS[base + 3].ySign).toBe(1);
			}
		});

		it('deltaX values are from the set {1, 17, 33, 49}', () => {
			const validDeltaX = new Set([1, 17, 33, 49]);
			for (let i = 20; i <= 83; i++) {
				expect(validDeltaX.has(TRIPLET_ENCODINGS[i].deltaX)).toBeTruthy();
			}
		});

		it('deltaY values are from the set {1, 17, 33, 49}', () => {
			const validDeltaY = new Set([1, 17, 33, 49]);
			for (let i = 20; i <= 83; i++) {
				expect(validDeltaY.has(TRIPLET_ENCODINGS[i].deltaY)).toBeTruthy();
			}
		});
	});

	// -----------------------------------------------------------------------
	// 8-bit X + 8-bit Y entries (indices 84-107)
	// -----------------------------------------------------------------------
	describe('indices 84-119 (8+8 bits)', () => {
		it('all have byteCount=3, xBits=8, yBits=8', () => {
			for (let i = 84; i <= 119; i++) {
				expect(TRIPLET_ENCODINGS[i].byteCount).toBe(3);
				expect(TRIPLET_ENCODINGS[i].xBits).toBe(8);
				expect(TRIPLET_ENCODINGS[i].yBits).toBe(8);
			}
		});

		it('deltaX values are from the set {1, 257, 513}', () => {
			const validDeltaX = new Set([1, 257, 513]);
			for (let i = 84; i <= 119; i++) {
				expect(validDeltaX.has(TRIPLET_ENCODINGS[i].deltaX)).toBeTruthy();
			}
		});

		it('deltaY values are from the set {1, 257, 513}', () => {
			const validDeltaY = new Set([1, 257, 513]);
			for (let i = 84; i <= 119; i++) {
				expect(validDeltaY.has(TRIPLET_ENCODINGS[i].deltaY)).toBeTruthy();
			}
		});
	});

	// -----------------------------------------------------------------------
	// 12-bit entries (indices 120-123)
	// -----------------------------------------------------------------------
	describe('indices 120-123 (12+12 bits)', () => {
		it('all have byteCount=4, xBits=12, yBits=12', () => {
			for (let i = 120; i <= 123; i++) {
				expect(TRIPLET_ENCODINGS[i].byteCount).toBe(4);
				expect(TRIPLET_ENCODINGS[i].xBits).toBe(12);
				expect(TRIPLET_ENCODINGS[i].yBits).toBe(12);
			}
		});

		it('all have deltaX=0 and deltaY=0', () => {
			for (let i = 120; i <= 123; i++) {
				expect(TRIPLET_ENCODINGS[i].deltaX).toBe(0);
				expect(TRIPLET_ENCODINGS[i].deltaY).toBe(0);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 16-bit entries (indices 124-127)
	// -----------------------------------------------------------------------
	describe('indices 124-127 (16+16 bits)', () => {
		it('all have byteCount=5, xBits=16, yBits=16', () => {
			for (let i = 124; i <= 127; i++) {
				expect(TRIPLET_ENCODINGS[i].byteCount).toBe(5);
				expect(TRIPLET_ENCODINGS[i].xBits).toBe(16);
				expect(TRIPLET_ENCODINGS[i].yBits).toBe(16);
			}
		});

		it('all have deltaX=0 and deltaY=0', () => {
			for (let i = 124; i <= 127; i++) {
				expect(TRIPLET_ENCODINGS[i].deltaX).toBe(0);
				expect(TRIPLET_ENCODINGS[i].deltaY).toBe(0);
			}
		});

		it('cover all four sign combinations', () => {
			expect(TRIPLET_ENCODINGS[124]).toMatchObject({ xSign: -1, ySign: -1 });
			expect(TRIPLET_ENCODINGS[125]).toMatchObject({ xSign: 1, ySign: -1 });
			expect(TRIPLET_ENCODINGS[126]).toMatchObject({ xSign: -1, ySign: 1 });
			expect(TRIPLET_ENCODINGS[127]).toMatchObject({ xSign: 1, ySign: 1 });
		});
	});

	// -----------------------------------------------------------------------
	// Usage with Stream bit reading
	// -----------------------------------------------------------------------
	describe('coordinate decoding logic', () => {
		it('index 0: Y-only negative movement with deltaY=0', () => {
			const enc = TRIPLET_ENCODINGS[0];
			// With raw Y value of 100 from the bitstream:
			const rawY = 100;
			const dy = (rawY + enc.deltaY) * enc.ySign;
			expect(dy).toBe(-100);
			// X should be 0 since xBits=0
			expect(enc.xBits).toBe(0);
		});

		it('index 23: both-axis positive movement (4-bit)', () => {
			const enc = TRIPLET_ENCODINGS[23];
			// xSign=1, ySign=1, deltaX=1, deltaY=1, 4-bit each
			const rawX = 5; // 4-bit value
			const rawY = 10;
			const dx = (rawX + enc.deltaX) * enc.xSign;
			const dy = (rawY + enc.deltaY) * enc.ySign;
			expect(dx).toBe(6);
			expect(dy).toBe(11);
		});

		it('index 87: 8-bit axis, positive X, positive Y, with deltas', () => {
			const enc = TRIPLET_ENCODINGS[87];
			expect(enc.byteCount).toBe(3);
			const rawX = 128;
			const rawY = 200;
			const dx = (rawX + enc.deltaX) * enc.xSign;
			const dy = (rawY + enc.deltaY) * enc.ySign;
			// Verify signs and deltas are applied
			expect(Math.abs(dx)).toBeGreaterThanOrEqual(enc.deltaX);
			expect(Math.abs(dy)).toBeGreaterThanOrEqual(enc.deltaY);
		});
	});
});
