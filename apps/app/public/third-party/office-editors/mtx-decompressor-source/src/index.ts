/**
 * mtx-decompressor — MicroType Express (MTX) font decompressor.
 *
 * Converts MTX-compressed font data (found inside EOT containers) back into
 * standard TrueType (.ttf) font files.
 *
 * Ported from libeot (MPL 2.0) by Brennan T. Vincent.
 * See: https://github.com/nicowilliams/libeot
 *
 * @packageDocumentation
 */

export { decompressMtx, decompressEotFont, unpackMtx } from './mtx-decompress';
export { parseCTF } from './ctf-parser';
export type { SFNTContainer, SFNTTable, ParseCTFOptions } from './ctf-parser';
export { EotError, EotErrorCode, EOT_WARN } from './errors';
export {
	parseEotMetadata,
	eotToTtf,
	canLegallyEdit,
	TTEMBED_SUBSET,
	TTEMBED_TTCOMPRESSED,
	TTEMBED_XORENCRYPTDATA,
} from './eot';
export type { EotMetadata, EotVersion } from './eot';
