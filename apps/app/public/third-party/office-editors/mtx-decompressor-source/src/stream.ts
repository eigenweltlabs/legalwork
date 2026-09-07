/**
 * Binary stream reader/writer for big-endian data.
 * Ported from libeot (MPL 2.0) util/stream.c
 */
import { EotError, EotErrorCode } from './errors';

export class Stream {
	buf: Uint8Array;
	size: number; // how much data has been written or is valid
	reserved: number; // allocated capacity
	pos: number; // current byte position
	bitPos: number; // current bit position within the byte at `pos`

	constructor(buf: Uint8Array | null, size: number) {
		if (buf) {
			this.buf = buf;
			this.size = size;
			this.reserved = buf.length;
		} else {
			this.buf = new Uint8Array(0);
			this.size = 0;
			this.reserved = 0;
		}
		this.pos = 0;
		this.bitPos = 0;
	}

	static fromExisting(buf: Uint8Array, size: number, reserved: number): Stream {
		const s = new Stream(null, 0);
		s.buf = buf;
		s.size = size;
		s.reserved = reserved;
		return s;
	}

	reserve(n: number): void {
		if (this.reserved >= n) {
			return;
		}
		const newBuf = new Uint8Array(n);
		newBuf.set(this.buf.subarray(0, this.size));
		this.buf = newBuf;
		this.reserved = n;
	}

	/**
	 * Reject byte-level access while the stream sits mid-byte (`bitPos != 0`).
	 *
	 * libeot returns `EOT_OFF_BYTE_BOUNDARY` for any byte read/write/seek issued
	 * before a partial byte has been consumed. The bit-level reader
	 * ({@link readNBits}) is the sole legitimate mid-byte accessor and bypasses
	 * this guard by touching `buf`/`pos` directly. On valid input the only
	 * `readNBits` caller consumes whole bytes per point, so the stream is always
	 * byte-aligned when a byte accessor runs and this guard never fires.
	 */
	private ensureByteAligned(): void {
		if (this.bitPos !== 0) {
			throw new EotError(
				EotErrorCode.OffByteBoundary,
				`Stream: byte-level access at a non-byte boundary (bitPos=${this.bitPos}, pos=${this.pos})`,
			);
		}
	}

	private ensureWrite(n: number): void {
		this.ensureByteAligned();
		const needed = this.pos + n;
		if (needed > this.reserved) {
			this.reserve(Math.max(needed, this.reserved * 2 || 256));
		}
		if (needed > this.size) {
			this.size = needed;
		}
	}

	private ensureRead(n: number): void {
		this.ensureByteAligned();
		if (this.pos + n > this.size) {
			throw new Error(
				`Stream: not enough data (need ${n} bytes at pos ${this.pos}, size ${this.size})`,
			);
		}
	}

	// --- Seek ---
	// A seek requires the stream to be byte-aligned and never clears `bitPos`
	// itself (mirroring libeot, which refuses to seek mid-byte rather than
	// silently re-aligning). The alignment guard leaves `bitPos` at 0.
	seekAbsolute(pos: number): void {
		this.ensureByteAligned();
		if (pos > this.size) {
			throw new Error(`Stream: seek past end (${pos} > ${this.size})`);
		}
		this.pos = pos;
	}

	seekRelative(offset: number): void {
		this.ensureByteAligned();
		const newPos = this.pos + offset;
		if (newPos < 0) {
			throw new Error('Stream: negative seek');
		}
		if (newPos > this.size) {
			throw new Error('Stream: seek past end');
		}
		this.pos = newPos;
	}

	// Seek into already-reserved-but-unwritten space, extending `size` up to the
	// seek target. libeot returns `EOT_SEEK_PAST_EOS` when the target exceeds the
	// reserved capacity; we mirror that rather than growing the buffer, so an
	// over-reach surfaces as a failure instead of a silent realloc.
	seekAbsoluteThroughReserve(pos: number): void {
		this.ensureByteAligned();
		if (pos > this.reserved) {
			throw new EotError(
				EotErrorCode.SeekPastEos,
				`Stream: seek to ${pos} past reserved end (${this.reserved})`,
			);
		}
		if (pos > this.size) {
			this.size = pos;
		}
		this.pos = pos;
	}

	seekRelativeThroughReserve(offset: number): void {
		this.seekAbsoluteThroughReserve(this.pos + offset);
	}

	// --- Read (Big-Endian) ---
	readU8(): number {
		this.ensureRead(1);
		return this.buf[this.pos++];
	}

	peekU8(): number {
		this.ensureRead(1);
		return this.buf[this.pos];
	}

	readU16(): number {
		this.ensureRead(2);
		const v = (this.buf[this.pos] << 8) | this.buf[this.pos + 1];
		this.pos += 2;
		return v;
	}

	readU24(): number {
		this.ensureRead(3);
		const v = (this.buf[this.pos] << 16) | (this.buf[this.pos + 1] << 8) | this.buf[this.pos + 2];
		this.pos += 3;
		return v;
	}

	readU32(): number {
		this.ensureRead(4);
		const v =
			((this.buf[this.pos] << 24) |
				(this.buf[this.pos + 1] << 16) |
				(this.buf[this.pos + 2] << 8) |
				this.buf[this.pos + 3]) >>>
			0;
		this.pos += 4;
		return v;
	}

	readS16(): number {
		const v = this.readU16();
		return v >= 0x8000 ? v - 0x10000 : v;
	}

	readS8(): number {
		const v = this.readU8();
		return v >= 0x80 ? v - 0x100 : v;
	}

	readChar(): string {
		return String.fromCharCode(this.readU8());
	}

	// --- Write (Big-Endian) ---
	writeU8(v: number): void {
		this.ensureWrite(1);
		this.buf[this.pos++] = v & 0xff;
	}

	writeU16(v: number): void {
		this.ensureWrite(2);
		this.buf[this.pos++] = (v >> 8) & 0xff;
		this.buf[this.pos++] = v & 0xff;
	}

	writeU24(v: number): void {
		if (v < 0 || v > 0xffffff) {
			throw new Error(`Stream: writeU24 value out of range: ${v}`);
		}
		this.ensureWrite(3);
		this.buf[this.pos++] = (v >> 16) & 0xff;
		this.buf[this.pos++] = (v >> 8) & 0xff;
		this.buf[this.pos++] = v & 0xff;
	}

	writeU32(v: number): void {
		this.ensureWrite(4);
		this.buf[this.pos++] = (v >>> 24) & 0xff;
		this.buf[this.pos++] = (v >> 16) & 0xff;
		this.buf[this.pos++] = (v >> 8) & 0xff;
		this.buf[this.pos++] = v & 0xff;
	}

	writeS16(v: number): void {
		this.writeU16(v < 0 ? v + 0x10000 : v);
	}

	writeS8(v: number): void {
		this.writeU8(v < 0 ? v + 0x100 : v);
	}

	// --- Bit-level reading (for triplet coordinate decoding) ---
	readNBits(n: number): number {
		if (n === 0) {
			return 0;
		}
		if (n > 32) {
			throw new Error(`Stream: readNBits width out of range: ${n} (max 32)`);
		}
		let value = 0;
		let bitsRemaining = n;
		while (bitsRemaining > 0) {
			if (this.pos >= this.size && this.bitPos === 0) {
				throw new Error('Stream: not enough data for bit read');
			}
			const bitsAvailableInByte = 8 - this.bitPos;
			const bitsToRead = Math.min(bitsRemaining, bitsAvailableInByte);
			const shift = bitsAvailableInByte - bitsToRead;
			const mask = ((1 << bitsToRead) - 1) << shift;
			value = (value << bitsToRead) | ((this.buf[this.pos] & mask) >> shift);
			this.bitPos += bitsToRead;
			if (this.bitPos >= 8) {
				this.bitPos = 0;
				this.pos++;
			}
			bitsRemaining -= bitsToRead;
		}
		// Normalize to unsigned: a 32-bit read whose top bit is set would
		// otherwise surface as a negative number (JS `<<` is signed).
		return value >>> 0;
	}

	// --- Copy ---
	/**
	 * Copy `length` bytes from this stream to `dest`.
	 *
	 * Both streams must be byte-aligned. The destination must already have the
	 * capacity reserved: libeot returns `EOT_OUT_OF_RESERVED_SPACE` when a copy
	 * would overrun the reserved buffer, so we throw rather than auto-growing —
	 * an under-reservation is a bug we want surfaced, not silently patched.
	 */
	copyTo(dest: Stream, length: number): void {
		this.ensureByteAligned();
		dest.ensureByteAligned();
		if (this.pos + length > this.size) {
			throw new Error('Stream: not enough data for copy');
		}
		const needed = dest.pos + length;
		if (needed > dest.reserved) {
			throw new EotError(
				EotErrorCode.OutOfReservedSpace,
				`Stream: copy of ${length} bytes exceeds reserved capacity (need ${needed}, reserved ${dest.reserved})`,
			);
		}
		dest.buf.set(this.buf.subarray(this.pos, this.pos + length), dest.pos);
		this.pos += length;
		dest.pos += length;
		if (dest.pos > dest.size) {
			dest.size = dest.pos;
		}
	}

	/** Read rest of data as 4-byte-aligned U32 values. Returns 0 on incomplete read. */
	readRestAsU32(): number | null {
		if (this.pos + 4 > this.size) {
			// Pad remaining bytes
			if (this.pos >= this.size) {
				return null;
			}
			let val = 0;
			const remaining = this.size - this.pos;
			for (let i = 0; i < 4; i++) {
				val <<= 8;
				if (i < remaining) {
					val |= this.buf[this.pos + i];
				}
			}
			this.pos = this.size;
			return val >>> 0;
		}
		return this.readU32();
	}

	/**
	 * Compute the SFNT-style checksum of bytes in `[beginPos, endPos)` as a sum
	 * of big-endian U32 words, zero-padding a final partial word. Bounds strictly
	 * on `endPos` (not the stream's `size`), so an unaligned range never folds in
	 * bytes past `endPos`. Leaves the stream position unchanged.
	 */
	checksumU32(beginPos: number, endPos: number): number {
		if (beginPos > endPos) {
			throw new Error(`Stream: checksumU32 beginPos ${beginPos} > endPos ${endPos}`);
		}
		if (endPos > this.size) {
			throw new Error(`Stream: checksumU32 endPos ${endPos} exceeds size ${this.size}`);
		}
		let sum = 0;
		for (let p = beginPos; p < endPos; p += 4) {
			let word = 0;
			for (let i = 0; i < 4; i++) {
				word = (word << 8) | (p + i < endPos ? this.buf[p + i] : 0);
			}
			sum = (sum + (word >>> 0)) >>> 0;
		}
		return sum;
	}

	/** Get a copy of the written data. */
	toUint8Array(): Uint8Array {
		return this.buf.slice(0, this.size);
	}
}
