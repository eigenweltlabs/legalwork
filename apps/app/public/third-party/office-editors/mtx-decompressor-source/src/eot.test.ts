import { describe, it, expect } from 'vitest';

import {
	parseEotMetadata,
	eotToTtf,
	canLegallyEdit,
	TTEMBED_TTCOMPRESSED,
	TTEMBED_XORENCRYPTDATA,
	type EotVersion,
} from './eot';
import { EotError, EotErrorCode } from './errors';

// ---------------------------------------------------------------------------
// EOT fixture builder — writes a little-endian EOT header + trailing font data.
// ---------------------------------------------------------------------------

interface EotFixture {
	version?: EotVersion;
	flags?: number;
	permissions?: number;
	familyName?: string;
	styleName?: string;
	versionName?: string;
	fullName?: string;
	rootString?: string;
	fontData?: Uint8Array;
	/** Override the version magic in the file (to test bad-version handling). */
	versionMagicOverride?: number;
}

const VERSION_MAGIC: Record<EotVersion, number> = {
	1: 0x00010000,
	2: 0x00020001,
	3: 0x00020002,
};

/** Grow-able little-endian writer. */
class LE {
	private bytes: number[] = [];
	u8(v: number): void {
		this.bytes.push(v & 0xff);
	}
	u16(v: number): void {
		this.u8(v);
		this.u8(v >>> 8);
	}
	u32(v: number): void {
		this.u16(v & 0xffff);
		this.u16(v >>> 16);
	}
	raw(a: Uint8Array | number[]): void {
		for (const b of a) this.u8(b);
	}
	/** Length-prefixed (U16LE byte count) UTF-16LE string. */
	str(s: string): void {
		this.u16(s.length * 2);
		for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
	}
	get length(): number {
		return this.bytes.length;
	}
	toUint8Array(): Uint8Array {
		return new Uint8Array(this.bytes);
	}
}

function buildEot(fix: EotFixture = {}): Uint8Array {
	const version = fix.version ?? 1;
	const fontData = fix.fontData ?? new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
	const flags = fix.flags ?? 0;
	const permissions = fix.permissions ?? 0;

	// Build the header body (everything after the fixed 12-byte prologue).
	const body = new LE();
	body.u32(flags);
	body.raw(new Uint8Array(10)); // PANOSE
	body.u8(0); // charset
	body.u8(0); // italic
	body.u32(400); // weight
	body.u16(permissions);
	body.u16(0x504c); // magic "LP"
	for (let i = 0; i < 4; i++) body.u32(0); // unicodeRange
	for (let i = 0; i < 2; i++) body.u32(0); // codePageRange
	body.u32(0); // checkSumAdjustment
	body.raw(new Uint8Array(16)); // Reserved1..4
	body.u16(0); // Padding1
	body.str(fix.familyName ?? 'Fam');
	body.u16(0); // Padding2
	body.str(fix.styleName ?? 'Reg');
	body.u16(0); // Padding3
	body.str(fix.versionName ?? 'v1');
	body.u16(0); // Padding4
	body.str(fix.fullName ?? 'Fam Reg');
	if (version > 1) {
		body.u16(0); // Padding5
		body.str(fix.rootString ?? '');
		if (version === 3) {
			body.u32(0); // root string checksum
			body.u32(0); // EUDC code page
			body.u16(0); // Padding6
			body.u16(0); // signature size (0)
			body.u32(0); // EUDC flags
			body.u32(0); // EUDC font data size (0)
		}
	}

	const bodyBytes = body.toUint8Array();
	const fontDataSize = fontData.length;
	const totalSize = 12 + bodyBytes.length + fontDataSize;

	const out = new LE();
	out.u32(totalSize);
	out.u32(fontDataSize);
	out.u32(fix.versionMagicOverride ?? VERSION_MAGIC[version]);
	out.raw(bodyBytes);
	out.raw(fontData);
	return out.toUint8Array();
}

describe('parseEotMetadata', () => {
	it('parses a version 1 header and locates the font data', () => {
		const fontData = new Uint8Array([1, 2, 3, 4, 5]);
		const eot = buildEot({ version: 1, fontData, familyName: 'Helvetica' });
		const meta = parseEotMetadata(eot);

		expect(meta.version).toBe(1);
		expect(meta.familyName).toBe('Helvetica');
		expect(meta.fontDataSize).toBe(5);
		expect(meta.badVersion).toBe(false);
		// The located font data must match what we appended.
		expect(eot.subarray(meta.fontDataOffset, meta.fontDataOffset + meta.fontDataSize)).toStrictEqual(
			fontData,
		);
	});

	it('decodes the compressed/encrypted flags', () => {
		const eot = buildEot({ flags: TTEMBED_TTCOMPRESSED | TTEMBED_XORENCRYPTDATA });
		const meta = parseEotMetadata(eot);
		expect(meta.compressed).toBe(true);
		expect(meta.encrypted).toBe(true);
	});

	it('treats absent compression/encryption flags as false', () => {
		const meta = parseEotMetadata(buildEot({ flags: 0 }));
		expect(meta.compressed).toBe(false);
		expect(meta.encrypted).toBe(false);
	});

	it('parses version 2 with a root string', () => {
		const eot = buildEot({ version: 2, rootString: 'ROOT', familyName: 'Arial' });
		const meta = parseEotMetadata(eot);
		expect(meta.version).toBe(2);
		expect(meta.rootString).toBe('ROOT');
		expect(meta.familyName).toBe('Arial');
	});

	it('parses version 3 including the EUDC trailer', () => {
		const fontData = new Uint8Array([9, 8, 7]);
		const eot = buildEot({ version: 3, fontData, fullName: 'Times New Roman' });
		const meta = parseEotMetadata(eot);
		expect(meta.version).toBe(3);
		expect(meta.fullName).toBe('Times New Roman');
		expect(eot.subarray(meta.fontDataOffset, meta.fontDataOffset + meta.fontDataSize)).toStrictEqual(
			fontData,
		);
	});

	it('flags a bad version and still parses when the magic disagrees with the layout', () => {
		// A version-2 layout mislabeled with the version-1 magic. The retry loop
		// should bump the version up and succeed with badVersion set.
		const eot = buildEot({ version: 2, rootString: 'X', versionMagicOverride: VERSION_MAGIC[1] });
		const meta = parseEotMetadata(eot);
		expect(meta.badVersion).toBe(true);
		expect(meta.rootString).toBe('X');
	});

	it('throws CorruptFile on a bad magic number', () => {
		const eot = buildEot();
		// Corrupt the 0x504C magic (little-endian at body offset: prologue 12 +
		// flags 4 + panose 10 + charset 1 + italic 1 + weight 4 + permissions 2 = 34).
		eot[34] = 0x00;
		eot[35] = 0x00;
		try {
			parseEotMetadata(eot);
			expect.fail('expected a CorruptFile error');
		} catch (e) {
			expect(e).toBeInstanceOf(EotError);
			expect((e as EotError).code).toBe(EotErrorCode.CorruptFile);
		}
	});

	it('throws CorruptFile on an unknown version magic', () => {
		const eot = buildEot({ versionMagicOverride: 0xdeadbeef });
		try {
			parseEotMetadata(eot);
			expect.fail('expected a CorruptFile error');
		} catch (e) {
			expect((e as EotError).code).toBe(EotErrorCode.CorruptFile);
		}
	});

	it('throws InsufficientBytes on a truncated file', () => {
		try {
			parseEotMetadata(new Uint8Array(4));
			expect.fail('expected an InsufficientBytes error');
		} catch (e) {
			expect((e as EotError).code).toBe(EotErrorCode.InsufficientBytes);
		}
	});
});

describe('eotToTtf', () => {
	it('returns the raw font data when neither compressed nor encrypted', () => {
		const fontData = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
		const eot = buildEot({ flags: 0, fontData });
		expect(eotToTtf(eot)).toStrictEqual(fontData);
	});

	it('XOR-decrypts uncompressed data with key 0x50', () => {
		const plain = new Uint8Array([0x00, 0x50, 0xff, 0xa5]);
		const encrypted = plain.map((b) => b ^ 0x50);
		const eot = buildEot({ flags: TTEMBED_XORENCRYPTDATA, fontData: encrypted });
		expect(eotToTtf(eot)).toStrictEqual(plain);
	});
});

describe('canLegallyEdit', () => {
	const base = parseEotMetadata(buildEot());

	it('allows editing when permissions are 0 (installable)', () => {
		expect(canLegallyEdit({ ...base, permissions: 0 })).toBe(true);
	});

	it('allows editing when the editable-embedding bit is set', () => {
		expect(canLegallyEdit({ ...base, permissions: 0x0008 })).toBe(true);
	});

	it('forbids editing for restricted-license fonts', () => {
		expect(canLegallyEdit({ ...base, permissions: 0x0002 })).toBe(false);
	});
});
