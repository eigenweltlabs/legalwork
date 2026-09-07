import { describe, expect, it } from 'vitest';

import { BIT_SAMPLES, VALUE_SAMPLES } from './__fixtures__/bit-samples';
import { BitIO } from './bitio';

describe('BitIO (fixtures)', () => {
	it.each(BIT_SAMPLES)('inputBit reads $name MSB-first', ({ bytes, bits }) => {
		const io = new BitIO(Uint8Array.from(bytes));
		for (const bit of bits) {
			expect(io.inputBit()).toBe(bit === 1);
		}
	});

	it.each(VALUE_SAMPLES)('readValue decodes $name', ({ bytes, width, value }) => {
		const io = new BitIO(Uint8Array.from(bytes));
		expect(io.readValue(width)).toBe(value);
	});

	it('readValue can split bytes into nibbles', () => {
		const io = new BitIO(Uint8Array.from([0xb2, 0x4d]));
		expect(io.readValue(4)).toBe(0xb);
		expect(io.readValue(4)).toBe(0x2);
		expect(io.readValue(4)).toBe(0x4);
		expect(io.readValue(4)).toBe(0xd);
	});

	it('throws when reading past the end of the buffer', () => {
		const io = new BitIO(Uint8Array.from([0xff]), 0, 1);
		expect(io.readValue(8)).toBe(0xff);
		expect(() => io.inputBit()).toThrow('end of data');
	});
});
