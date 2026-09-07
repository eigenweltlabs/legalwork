import { describe, expect, it } from 'vitest';

import { WIDTH_SAMPLES } from './__fixtures__/value-edge-samples';
import { BitIO } from './bitio';

describe('BitIO — narrow widths (fixtures)', () => {
	it.each(WIDTH_SAMPLES)('readValue $name -> $value', ({ bytes, width, value }) => {
		const io = new BitIO(Uint8Array.from(bytes));
		expect(io.readValue(width)).toBe(value);
	});
});
