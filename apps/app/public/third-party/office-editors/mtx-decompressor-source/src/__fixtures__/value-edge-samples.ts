/**
 * Narrow-width bit-reading fixtures for the MSB-first BitIO reader tests.
 */

export interface WidthSample {
	readonly name: string;
	readonly bytes: readonly number[];
	readonly width: number;
	readonly value: number;
}

export const WIDTH_SAMPLES: readonly WidthSample[] = [
	{ name: '1 bit set', bytes: [0x80], width: 1, value: 1 },
	{ name: '1 bit clear', bytes: [0x00], width: 1, value: 0 },
	{ name: '2 bits', bytes: [0xc0], width: 2, value: 3 },
	{ name: '3 high bits', bytes: [0xe0], width: 3, value: 7 },
	{ name: '3 bits, low set', bytes: [0x20], width: 3, value: 1 },
	{ name: '4 bits', bytes: [0xa0], width: 4, value: 0xa },
];
