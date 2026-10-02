// B7-13 (lane c45a): a minimal QR code encoder for the "Installer chez toi"
// page, so the site URL can be scanned from another phone without any npm
// dependency. Byte mode only, error correction level M, versions 1 to 10
// (up to 213 bytes: a site URL is a few dozen), all 8 masks scored with the
// standard penalty rules. Follows ISO/IEC 18004 the same way the usual
// reference encoders do: function patterns, format bits, Reed-Solomon over
// GF(2^8) with 0x11D, zigzag placement, mask selection. Pure functions, no
// DOM: the page renders `modules` as SVG rects.

export interface QrMatrix {
	/** Modules per side (21 for version 1, +4 per version). */
	size: number;
	/** Symbol version (1..10). */
	version: number;
	/** Chosen mask pattern (0..7). */
	mask: number;
	/** modules[y][x] === true for a dark module. */
	modules: boolean[][];
}

/** Error correction level M: codewords per block and number of blocks, versions 1..10. */
const ECC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;
/** Format bits for level M (two-bit indicator 00) shifted with the mask. */
const ECL_M_BITS = 0;

/** Raw data modules available for codewords, before error correction (spec table 1 formula). */
export function rawDataModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const numAlign = Math.floor(version / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (version >= 7) result -= 36;
	}
	return result;
}

/** Data codewords available at level M for `version`. */
export function dataCodewords(version: number): number {
	return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK_M[version] * BLOCKS_M[version];
}

/** UTF-8 bytes of `text` (TextEncoder when present, manual otherwise). */
export function utf8Bytes(text: string): number[] {
	if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
	const out: number[] = [];
	for (let i = 0; i < text.length; i++) {
		let c = text.codePointAt(i) as number;
		if (c > 0xffff) i++;
		if (c < 0x80) out.push(c);
		else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
		else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
	}
	return out;
}

/** Smallest version (1..10) whose level M capacity holds `byteLen` bytes in byte mode, or 0. */
export function versionFor(byteLen: number): number {
	for (let v = 1; v <= MAX_VERSION; v++) {
		const countBits = v <= 9 ? 8 : 16;
		const bits = 4 + countBits + 8 * byteLen;
		if (bits <= dataCodewords(v) * 8) return v;
	}
	return 0;
}

// --- Reed-Solomon over GF(2^8), reducing polynomial 0x11D ---

export function gfMultiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

/** Generator polynomial of `degree` (coefficients of x^(degree-1) .. x^0, leading term implicit). */
export function rsGenerator(degree: number): number[] {
	const result: number[] = new Array(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			result[j] = gfMultiply(result[j], root);
			if (j + 1 < degree) result[j] ^= result[j + 1];
		}
		root = gfMultiply(root, 2);
	}
	return result;
}

/** Remainder of `data` divided by the generator `divisor` (the ECC codewords). */
export function rsRemainder(data: number[], divisor: number[]): number[] {
	const result: number[] = new Array(divisor.length).fill(0);
	for (const b of data) {
		const factor = b ^ (result.shift() as number);
		result.push(0);
		for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
	}
	return result;
}

/** Byte-mode data codewords for `bytes` at `version`: mode, count, data, terminator, padding. */
export function dataCodewordsFor(bytes: number[], version: number): number[] {
	const bits: number[] = [];
	const push = (val: number, len: number) => {
		for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
	};
	push(4, 4);
	push(bytes.length, version <= 9 ? 8 : 16);
	for (const b of bytes) push(b, 8);
	const capacity = dataCodewords(version) * 8;
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
	const out: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let b = 0;
		for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
		out.push(b);
	}
	return out;
}

/** Splits data into blocks, appends each block's ECC, interleaves (spec 7.5 / 7.6). */
export function addEccAndInterleave(data: number[], version: number): number[] {
	const numBlocks = BLOCKS_M[version];
	const eccLen = ECC_PER_BLOCK_M[version];
	const rawCodewords = Math.floor(rawDataModules(version) / 8);
	const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
	const shortBlockLen = Math.floor(rawCodewords / numBlocks);
	const gen = rsGenerator(eccLen);
	const blocks: number[][] = [];
	let k = 0;
	for (let i = 0; i < numBlocks; i++) {
		const len = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
		const dat = data.slice(k, k + len);
		k += len;
		const ecc = rsRemainder(dat, gen);
		if (i < numShortBlocks) dat.push(-1);
		blocks.push(dat.concat(ecc));
	}
	const result: number[] = [];
	for (let i = 0; i < blocks[0].length; i++) {
		for (let j = 0; j < blocks.length; j++) {
			if (i !== shortBlockLen - eccLen || j >= numShortBlocks) result.push(blocks[j][i]);
		}
	}
	return result;
}

/** Centre coordinates of the alignment patterns for `version` (empty for version 1). */
export function alignmentPositions(version: number): number[] {
	if (version === 1) return [];
	const numAlign = Math.floor(version / 7) + 2;
	const size = version * 4 + 17;
	const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
	const result = [6];
	for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
	return result;
}

/** Mask condition for pattern `mask` at (x, y). */
export function maskBit(mask: number, x: number, y: number): boolean {
	switch (mask) {
		case 0:
			return (x + y) % 2 === 0;
		case 1:
			return y % 2 === 0;
		case 2:
			return x % 3 === 0;
		case 3:
			return (x + y) % 3 === 0;
		case 4:
			return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5:
			return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6:
			return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		default:
			return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
	}
}

/** The 15 format bits (level M, `mask`) with their BCH remainder and the fixed XOR mask. */
export function formatBits(mask: number): number {
	const data = (ECL_M_BITS << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up). */
export function versionBits(version: number): number {
	let rem = version;
	for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
	return (version << 12) | rem;
}

class Symbol {
	readonly size: number;
	readonly modules: boolean[][];
	readonly isFunction: boolean[][];
	constructor(readonly version: number) {
		this.size = version * 4 + 17;
		this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
		this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
	}
	setFunction(x: number, y: number, dark: boolean) {
		this.modules[y][x] = dark;
		this.isFunction[y][x] = true;
	}
	drawFinder(cx: number, cy: number) {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const x = cx + dx;
				const y = cy + dy;
				if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.setFunction(x, y, dist !== 2 && dist !== 4);
			}
		}
	}
	drawAlignment(cx: number, cy: number) {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	}
	drawFormat(mask: number) {
		const bits = formatBits(mask);
		const bit = (i: number) => ((bits >>> i) & 1) === 1;
		for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
		this.setFunction(8, 7, bit(6));
		this.setFunction(8, 8, bit(7));
		this.setFunction(7, 8, bit(8));
		for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
		for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
		this.setFunction(8, this.size - 8, true);
	}
	drawVersion() {
		if (this.version < 7) return;
		const bits = versionBits(this.version);
		for (let i = 0; i < 18; i++) {
			const b = ((bits >>> i) & 1) === 1;
			const a = this.size - 11 + (i % 3);
			const c = Math.floor(i / 3);
			this.setFunction(a, c, b);
			this.setFunction(c, a, b);
		}
	}
	drawFunctionPatterns() {
		for (let i = 0; i < this.size; i++) {
			this.setFunction(6, i, i % 2 === 0);
			this.setFunction(i, 6, i % 2 === 0);
		}
		this.drawFinder(3, 3);
		this.drawFinder(this.size - 4, 3);
		this.drawFinder(3, this.size - 4);
		const pos = alignmentPositions(this.version);
		const last = pos.length - 1;
		for (let i = 0; i < pos.length; i++) {
			for (let j = 0; j < pos.length; j++) {
				if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
				this.drawAlignment(pos[i], pos[j]);
			}
		}
		this.drawFormat(0);
		this.drawVersion();
	}
	drawCodewords(data: number[]) {
		let i = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < this.size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? this.size - 1 - vert : vert;
					if (!this.isFunction[y][x] && i < data.length * 8) {
						this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
						i++;
					}
				}
			}
		}
	}
	applyMask(mask: number) {
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				if (!this.isFunction[y][x] && maskBit(mask, x, y)) this.modules[y][x] = !this.modules[y][x];
			}
		}
	}
	penalty(): number {
		const n = this.size;
		let score = 0;
		const line = (get: (i: number) => boolean) => {
			let run = 0;
			let prev: boolean | null = null;
			let s = "";
			for (let i = 0; i < n; i++) {
				const v = get(i);
				s += v ? "1" : "0";
				if (v === prev) {
					run++;
					if (run === 5) score += 3;
					else if (run > 5) score++;
				} else {
					prev = v;
					run = 1;
				}
			}
			for (const pat of ["10111010000", "00001011101"]) {
				let at = s.indexOf(pat);
				while (at >= 0) {
					score += 40;
					at = s.indexOf(pat, at + 1);
				}
			}
		};
		for (let y = 0; y < n; y++) line((x) => this.modules[y][x]);
		for (let x = 0; x < n; x++) line((y) => this.modules[y][x]);
		for (let y = 0; y < n - 1; y++) {
			for (let x = 0; x < n - 1; x++) {
				const c = this.modules[y][x];
				if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) score += 3;
			}
		}
		let dark = 0;
		for (const row of this.modules) for (const m of row) if (m) dark++;
		const total = n * n;
		score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
		return score;
	}
}

/**
 * Encodes `text` (UTF-8, byte mode, level M) as a QR module matrix. Throws
 * when the text does not fit version 10 (213 bytes).
 */
export function encodeQr(text: string): QrMatrix {
	const bytes = utf8Bytes(text);
	const version = versionFor(bytes.length);
	if (!version) throw new Error(`qr: ${bytes.length} octets, trop long (213 max)`);
	const codewords = addEccAndInterleave(dataCodewordsFor(bytes, version), version);
	const sym = new Symbol(version);
	sym.drawFunctionPatterns();
	sym.drawCodewords(codewords);
	let best = 0;
	let bestScore = Infinity;
	for (let mask = 0; mask < 8; mask++) {
		sym.applyMask(mask);
		sym.drawFormat(mask);
		const s = sym.penalty();
		if (s < bestScore) {
			bestScore = s;
			best = mask;
		}
		sym.applyMask(mask);
	}
	sym.applyMask(best);
	sym.drawFormat(best);
	return { size: sym.size, version, mask: best, modules: sym.modules };
}

/** Dark modules as {x, y} pairs, for an SVG made of one rect per module. */
export function darkModules(m: QrMatrix): { x: number; y: number }[] {
	const out: { x: number; y: number }[] = [];
	for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.modules[y][x]) out.push({ x, y });
	return out;
}
