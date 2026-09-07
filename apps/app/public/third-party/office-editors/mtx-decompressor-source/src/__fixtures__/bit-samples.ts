/**
 * Bit-pattern fixtures for the MSB-first BitIO reader tests.
 */

/** A bit-reading sample: source bytes and the MSB-first bit sequence. */
export interface BitSample {
	readonly name: string;
	readonly bytes: readonly number[];
	readonly bits: readonly (0 | 1)[];
}

export const BIT_SAMPLES: readonly BitSample[] = [
	{ name: 'all ones', bytes: [0xff], bits: [1, 1, 1, 1, 1, 1, 1, 1] },
	{ name: 'all zeros', bytes: [0x00], bits: [0, 0, 0, 0, 0, 0, 0, 0] },
	{ name: 'alternating', bytes: [0xaa], bits: [1, 0, 1, 0, 1, 0, 1, 0] },
	{ name: 'single high bit', bytes: [0x80], bits: [1, 0, 0, 0, 0, 0, 0, 0] },
];

/** A value-reading sample: bytes, bit width, and the expected unsigned value. */
export interface ValueSample {
	readonly name: string;
	readonly bytes: readonly number[];
	readonly width: number;
	readonly value: number;
}

export const VALUE_SAMPLES: readonly ValueSample[] = [
	{ name: 'a full byte', bytes: [0xb2], width: 8, value: 0xb2 },
	{ name: 'two bytes', bytes: [0xb2, 0x4d], width: 16, value: 0xb24d },
	{ name: 'a value spanning a byte boundary', bytes: [0x0f, 0xf0], width: 16, value: 0x0ff0 },
];
