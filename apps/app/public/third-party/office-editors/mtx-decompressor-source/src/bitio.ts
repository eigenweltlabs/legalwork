/**
 * BitIO - MSB-first bit-level reader from a Uint8Array buffer.
 *
 * Ported from libeot (MPL 2.0) MTX_BITIO implementation.
 *
 * The reader maintains a single-byte shift register (`bitBuffer`).
 * Bits are consumed most-significant-bit first.  When all bits in the
 * current byte have been shifted out, the next byte is loaded
 * automatically.
 */
export class BitIO {
	private data: Uint8Array;
	private index: number;
	private size: number;
	private bitBuffer: number = 0;
	private bitCount: number = 0;

	/**
	 * @param data   Source byte buffer.
	 * @param offset Starting byte offset into `data`.
	 * @param size   Absolute end index into `data` (exclusive) — reading stops
	 *               once `index` reaches it. Defaults to `data.length`. Clamped
	 *               to `data.length` so an over-large value cannot read past the
	 *               end of the buffer and silently yield zero bits.
	 */
	constructor(data: Uint8Array, offset: number = 0, size?: number) {
		this.data = data;
		this.index = offset;
		this.size = Math.min(size ?? data.length, data.length);
	}

	/**
	 * Read a single bit from the stream.
	 *
	 * Mirrors `MTX_BITIO_input_bit`:
	 *   - If `bitCount` has reached 0, load the next byte into `bitBuffer`
	 *     and reset `bitCount` to 7.
	 *   - Shift `bitBuffer` left by 1.
	 *   - Return whether bit 8 (0x100) is set (i.e. the MSB that was
	 *     shifted out of the original byte value).
	 */
	inputBit(): boolean {
		if (this.bitCount === 0) {
			// Reload before consuming any bit, and throw *before* mutating any
			// state so a caught end-of-data error leaves the reader consistent
			// (a retry throws again rather than returning a stale bit).
			if (this.index >= this.size) {
				throw new Error('BitIO: end of data');
			}
			this.bitBuffer = this.data[this.index++];
			this.bitCount = 8;
		}
		this.bitCount--;
		this.bitBuffer <<= 1;
		return (this.bitBuffer & 0x100) !== 0;
	}

	/**
	 * Read an unsigned integer of `numberOfBits` width, MSB first.
	 *
	 * Mirrors `MTX_BITIO_ReadValue`: accumulates bits from the most
	 * significant down to the least significant.
	 */
	readValue(numberOfBits: number): number {
		let value = 0;
		for (let i = numberOfBits - 1; i >= 0; i--) {
			value <<= 1;
			if (this.inputBit()) {
				value |= 1;
			}
		}
		// Normalize to unsigned: a 32-bit-wide read whose top bit is set would
		// otherwise surface as a negative number (JS `<<` is signed). libeot's
		// MTX_BITIO_ReadValue returns an unsigned long.
		return value >>> 0;
	}
}
