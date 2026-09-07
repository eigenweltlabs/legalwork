/**
 * Adaptive Huffman coder using a splay-tree that maintains the sibling
 * property (nodes ordered by non-increasing weight).
 *
 * Ported from libeot (MPL 2.0) MTX_AHUFF implementation.
 *
 * Tree layout (1-indexed):
 *   - ROOT          = 1
 *   - Internal nodes = 1 .. range-1
 *   - Leaf nodes     = range .. 2*range-1
 *   - Leaf at index (range + i) encodes symbol i  (0 <= i < range)
 *
 * The tree is initialised as a perfect / near-perfect binary tree and
 * then optionally pre-biased depending on the symbol range.
 */
import { BitIO } from './bitio';

/** A single node in the adaptive Huffman tree. */
interface AHuffNode {
	/** Parent index (0 for the super-root sentinel). */
	up: number;
	/** Left child index (0 for leaves). */
	left: number;
	/** Right child index (0 for leaves). */
	right: number;
	/**
	 * Symbol code for leaves (>= 0), or -1 for internal nodes.
	 * A non-negative value signals "this is a leaf".
	 */
	code: number;
	/** Cumulative weight used to maintain the sibling property. */
	weight: number;
}

/**
 * Return the number of bits required to represent the non-negative integer `x`.
 * Equivalent to floor(log2(x)) + 1 for x > 0.
 *
 * libeot's `BitsUsed(0)` returns 1 (its mask cascade falls through to the low
 * bit); we match that so the function is a faithful port. In practice this
 * module only ever calls it with x > 0, so the zero case is defensive.
 */
function bitsUsed(x: number): number {
	if (x <= 0) {
		return 1;
	}
	return 32 - Math.clz32(x);
}

export class AHuff {
	private bio: BitIO;
	private range: number;
	private tree: AHuffNode[];
	/** Maps symbol value -> current tree index of its leaf node. */
	private symbolIndex: number[];

	/** Number of bits that encode a "full-size" symbol (ceil(log2(range))). */
	private bitCount: number;
	/**
	 * Secondary bit width used for large-range trees.
	 * 0 when range <= 256 (small tree path).
	 */
	private bitCount2: number;

	private static readonly ROOT = 1;

	constructor(bio: BitIO, range: number) {
		this.bio = bio;
		this.range = range;

		// Derive bit widths --------------------------------------------------
		// Matches C: bitCount2 is non-zero only for range 257..511
		this.bitCount = bitsUsed(range - 1);
		this.bitCount2 = 0;
		if (range > 256 && range < 512) {
			this.bitCount2 = bitsUsed(range - 256 - 1) + 1;
		}

		const treeSize = 2 * range; // indices 0 .. 2*range-1

		// Allocate the tree array (index 0 is unused sentinel) ---------------
		this.tree = Array.from<AHuffNode>({ length: treeSize });
		for (let i = 0; i < treeSize; i++) {
			this.tree[i] = { up: 0, left: 0, right: 0, code: -1, weight: 0 };
		}

		// Build parent pointers and set initial weight = 1 for all non-root
		// nodes (matching the C code which initializes weight=1 for i in 2..limit-1)
		for (let i = 2; i < treeSize; i++) {
			this.tree[i].up = i >> 1;
			this.tree[i].weight = 1;
		}

		// Internal nodes (1 .. range-1): set children, code = -1
		for (let i = 1; i < range; i++) {
			this.tree[i].left = 2 * i;
			this.tree[i].right = 2 * i + 1;
			this.tree[i].code = -1;
		}

		// Leaf nodes (range .. 2*range-1): code = symbol index
		// C code sets left=-1, right=-1 for leaves (distinguishes from
		// internal nodes which have left/right >= 0 in SwapNodes)
		for (let i = 0; i < range; i++) {
			const leafIdx = range + i;
			this.tree[leafIdx].code = i;
			this.tree[leafIdx].left = -1;
			this.tree[leafIdx].right = -1;
		}

		// Build symbolIndex: symbol i -> leaf index (range + i)
		this.symbolIndex = Array.from<number>({ length: range });
		for (let i = 0; i < range; i++) {
			this.symbolIndex[i] = range + i;
		}

		// Compute internal node weights bottom-up ----------------------------
		this.initWeight(AHuff.ROOT);

		// Pre-bias weights depending on tree size ----------------------------
		if (this.bitCount2 !== 0) {
			// Large tree (range > 256): bias specific control symbols
			this.updateWeight(this.symbolIndex[256]);
			this.updateWeight(this.symbolIndex[257]);

			// DUP2 symbol = range - 3: 12 extra weight bumps
			const dup2Sym = range - 3;
			for (let i = 0; i < 12; i++) {
				this.updateWeight(this.symbolIndex[dup2Sym]);
			}

			// DUP4 symbol = range - 2: 6 extra weight bumps
			const dup4Sym = range - 2;
			for (let i = 0; i < 6; i++) {
				this.updateWeight(this.symbolIndex[dup4Sym]);
			}
		} else {
			// Small tree (range <= 256): update every symbol twice
			for (let j = 0; j < 2; j++) {
				for (let i = 0; i < range; i++) {
					this.updateWeight(this.symbolIndex[i]);
				}
			}
		}
	}

	// --------------------------------------------------------------------
	// Public API
	// --------------------------------------------------------------------

	/**
	 * Decode one symbol from the bit stream.
	 *
	 * Starting at ROOT, read one bit at a time:
	 *   - 0 → go left
	 *   - 1 → go right
	 * Continue until a leaf (code >= 0) is reached.  Then update the
	 * tree weights and return the symbol code.
	 */
	readSymbol(): number {
		let a = AHuff.ROOT;
		let symbol: number;

		// Traverse tree from ROOT to leaf (matches C do-while)
		do {
			a = this.bio.inputBit() ? this.tree[a].right : this.tree[a].left;
			symbol = this.tree[a].code;
		} while (symbol < 0);

		// Update adaptive weights for the decoded leaf
		this.updateWeight(a);

		return symbol;
	}

	// --------------------------------------------------------------------
	// Private helpers
	// --------------------------------------------------------------------

	/**
	 * Increment the weight of node `a` and propagate up to ROOT,
	 * swapping nodes as necessary to maintain the sibling property
	 * (nodes in non-increasing weight order by index).
	 *
	 * Algorithm:
	 *   For each node from `a` up to (but not including) ROOT:
	 *     1. Look at the predecessor (a-1).
	 *     2. If it has the same weight, scan backwards to find the first
	 *        node with that weight.
	 *     3. Swap `a` with that first node (unless it is ROOT or `a`'s
	 *        own parent) to restore ordering.
	 *     4. Increment `a`'s weight.
	 *     5. Move to `a`'s parent.
	 *   Finally increment ROOT's weight.
	 */
	private updateWeight(a: number): void {
		const tree = this.tree;

		for (; a !== AHuff.ROOT; a = tree[a].up) {
			const weightA = tree[a].weight;
			let b = a - 1;

			// C reference: scan backward while tree[b].weight == weightA,
			// then b++ to land on the first node with that weight.
			if (tree[b].weight === weightA) {
				do {
					b--;
				} while (tree[b].weight === weightA);
				b++;
				if (b > AHuff.ROOT) {
					this.swapNodes(a, b);
					a = b;
				}
			}

			tree[a].weight = weightA + 1;
		}

		// Increment ROOT weight
		tree[AHuff.ROOT].weight++;
	}

	/**
	 * Swap two nodes in the tree while keeping the parent linkage
	 * consistent.
	 *
	 * What gets swapped: left, right, code, weight — everything that
	 * defines the *content* of the node.  The `up` pointer stays with
	 * the position (the parent still points here).
	 *
	 * After the content swap we must:
	 *   1. Fix children's `up` pointers (they now live under the other
	 *      position).
	 *   2. Fix `symbolIndex` for leaves so we can still find them by
	 *      symbol value.
	 */
	private swapNodes(a: number, b: number): void {
		const tree = this.tree;

		// Save parent pointers (these are position-specific, not content)
		const upa = tree[a].up;
		const upb = tree[b].up;

		// Swap the entire node content (matches C: tNode = tree[a]; tree[a] = tree[b]; tree[b] = tNode)
		const tmp = tree[a];
		tree[a] = tree[b];
		tree[b] = tmp;

		// Restore parent pointers to their original positions
		tree[a].up = upa;
		tree[b].up = upb;

		// Fix children's up-pointers and symbolIndex -------------------------
		let code = tree[a].code;
		if (code < 0) {
			// Internal node: fix children's parent pointers
			tree[tree[a].left].up = a;
			tree[tree[a].right].up = a;
		} else {
			// Leaf node: fix symbolIndex
			this.symbolIndex[code] = a;
		}

		code = tree[b].code;
		if (code < 0) {
			tree[tree[b].left].up = b;
			tree[tree[b].right].up = b;
		} else {
			this.symbolIndex[code] = b;
		}
	}

	/**
	 * Recursively compute weights for internal nodes after the initial
	 * tree construction.  Leaf weights are already set to 1.
	 *
	 * weight(internal) = weight(left) + weight(right)
	 */
	private initWeight(a: number): number {
		const node = this.tree[a];
		if (node.code >= 0) {
			// Leaf — weight is already 1
			return node.weight;
		}
		node.weight = this.initWeight(node.left) + this.initWeight(node.right);
		return node.weight;
	}
}
