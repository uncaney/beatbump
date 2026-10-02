import { describe, expect, it } from "vitest";
import {
	addEccAndInterleave,
	alignmentPositions,
	dataCodewords,
	dataCodewordsFor,
	darkModules,
	encodeQr,
	formatBits,
	maskBit,
	rsGenerator,
	rsRemainder,
	utf8Bytes,
	versionFor,
	type QrMatrix,
} from "./qr";

const URL_SHORT = "https://music.ekaii.fr";

/** Reads the codewords back from a matrix: unmask the data modules, walk the zigzag. */
function readCodewords(m: QrMatrix, isFunction: boolean[][]): number[] {
	const bits: number[] = [];
	for (let right = m.size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < m.size; vert++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? m.size - 1 - vert : vert;
				if (!isFunction[y][x]) bits.push(m.modules[y][x] !== maskBit(m.mask, x, y) ? 1 : 0);
			}
		}
	}
	const out: number[] = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		let b = 0;
		for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
		out.push(b);
	}
	return out;
}

/** Function-module map for versions 1..6 (finders + separators, timing, format, alignment, dark module). */
function functionMap(m: QrMatrix): boolean[][] {
	const n = m.size;
	const f = Array.from({ length: n }, () => new Array(n).fill(false));
	const box = (x0: number, y0: number, w: number, h: number) => {
		for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < n && y < n) f[y][x] = true;
	};
	box(0, 0, 9, 9);
	box(n - 8, 0, 8, 9);
	box(0, n - 8, 9, 8);
	for (let i = 0; i < n; i++) {
		f[6][i] = true;
		f[i][6] = true;
	}
	const pos = alignmentPositions(m.version);
	const last = pos.length - 1;
	for (let i = 0; i < pos.length; i++) {
		for (let j = 0; j < pos.length; j++) {
			if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
			box(pos[i] - 2, pos[j] - 2, 5, 5);
		}
	}
	return f;
}

const finderAt = (m: QrMatrix, cx: number, cy: number) => {
	for (let dy = -4; dy <= 4; dy++) {
		for (let dx = -4; dx <= 4; dx++) {
			const x = cx + dx;
			const y = cy + dy;
			if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue;
			const dist = Math.max(Math.abs(dx), Math.abs(dy));
			if (m.modules[y][x] !== (dist !== 2 && dist !== 4)) return false;
		}
	}
	return true;
};

describe("qr: Reed-Solomon", () => {
	it("generator polynomial of degree 7 matches the published coefficients", () => {
		expect(rsGenerator(7)).toEqual([127, 122, 154, 164, 11, 68, 117]);
	});
	it("ECC of the spec's 1-M 'HELLO WORLD' data codewords is the published vector", () => {
		const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
		expect(rsRemainder(data, rsGenerator(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
	});
	it("a full block (data + ECC) is divisible by the generator", () => {
		const data = dataCodewordsFor(utf8Bytes(URL_SHORT), 2);
		const block = addEccAndInterleave(data, 2);
		expect(block).toHaveLength(44);
		expect(block.slice(0, 28)).toEqual(data);
		expect(rsRemainder(block, rsGenerator(16)).every((b) => b === 0)).toBe(true);
	});
	it("interleaves two blocks at version 4 without any placeholder leaking", () => {
		const text = "a".repeat(60);
		expect(versionFor(60)).toBe(4);
		const out = addEccAndInterleave(dataCodewordsFor(utf8Bytes(text), 4), 4);
		expect(out).toHaveLength(100);
		expect(out.every((b) => b >= 0 && b <= 255)).toBe(true);
	});
});

describe("qr: capacity and format", () => {
	it("picks the smallest level-M version", () => {
		expect(dataCodewords(1)).toBe(16);
		expect(dataCodewords(2)).toBe(28);
		expect(dataCodewords(10)).toBe(216);
		expect(versionFor(utf8Bytes("ekaii.fr").length)).toBe(1);
		expect(versionFor(utf8Bytes(URL_SHORT).length)).toBe(2);
		expect(versionFor(213)).toBe(10);
		expect(versionFor(214)).toBe(0);
		expect(() => encodeQr("x".repeat(214))).toThrow();
	});
	it("format bits are the published level-M values", () => {
		expect(formatBits(0)).toBe(0x5412);
		expect(formatBits(1)).toBe(0x5125);
	});
	it("byte mode header: mode 0100, 8-bit count, then the bytes, then terminator and padding", () => {
		const cw = dataCodewordsFor([0x41, 0x42], 1);
		expect(cw).toHaveLength(16);
		expect(cw.slice(0, 4)).toEqual([0x40, 0x24, 0x14, 0x20]);
		expect(cw.slice(4)).toEqual([0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
	});
	it("alignment pattern centres", () => {
		expect(alignmentPositions(1)).toEqual([]);
		expect(alignmentPositions(2)).toEqual([6, 18]);
		expect(alignmentPositions(7)).toEqual([6, 22, 38]);
	});
});

describe("qr: encodeQr", () => {
	const m = encodeQr(URL_SHORT);
	it("a short site URL is a 25x25 version 2 symbol", () => {
		expect(m.version).toBe(2);
		expect(m.size).toBe(25);
		expect(m.modules).toHaveLength(25);
		expect(m.modules.every((r) => r.length === 25)).toBe(true);
		expect(m.mask).toBeGreaterThanOrEqual(0);
		expect(m.mask).toBeLessThanOrEqual(7);
	});
	it("has the three finder patterns, the timing patterns, the alignment pattern and the dark module", () => {
		expect(finderAt(m, 3, 3)).toBe(true);
		expect(finderAt(m, m.size - 4, 3)).toBe(true);
		expect(finderAt(m, 3, m.size - 4)).toBe(true);
		for (let i = 8; i < m.size - 8; i++) {
			expect(m.modules[6][i]).toBe(i % 2 === 0);
			expect(m.modules[i][6]).toBe(i % 2 === 0);
		}
		expect(m.modules[m.size - 8][8]).toBe(true);
		for (let dy = -2; dy <= 2; dy++)
			for (let dx = -2; dx <= 2; dx++) expect(m.modules[18 + dy][18 + dx]).toBe(Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
	});
	it("carries the format bits of its mask in both copies", () => {
		const bits = formatBits(m.mask);
		const bit = (i: number) => ((bits >>> i) & 1) === 1;
		for (let i = 0; i <= 5; i++) expect(m.modules[i][8]).toBe(bit(i));
		expect(m.modules[7][8]).toBe(bit(6));
		expect(m.modules[8][8]).toBe(bit(7));
		expect(m.modules[8][7]).toBe(bit(8));
		for (let i = 9; i < 15; i++) expect(m.modules[8][14 - i]).toBe(bit(i));
		for (let i = 0; i < 8; i++) expect(m.modules[8][m.size - 1 - i]).toBe(bit(i));
		for (let i = 8; i < 15; i++) expect(m.modules[m.size - 15 + i][8]).toBe(bit(i));
	});
	it("the data region reads back as the URL's codewords and a valid RS block", () => {
		const read = readCodewords(m, functionMap(m));
		const expected = addEccAndInterleave(dataCodewordsFor(utf8Bytes(URL_SHORT), 2), 2);
		expect(read.slice(0, 44)).toEqual(expected);
		expect(rsRemainder(read.slice(0, 44), rsGenerator(16)).every((b) => b === 0)).toBe(true);
		expect(read[0]).toBe(0x40 | (22 >> 4));
		const text = Buffer.from(read.slice(0, 44));
		const bytes: number[] = [];
		for (let i = 0; i < 22; i++) bytes.push(((text[1 + i] & 0x0f) << 4) | (text[2 + i] >> 4));
		expect(String.fromCharCode(...bytes)).toBe(URL_SHORT);
	});
	it("encodes a 1-byte text as version 1 and non-ASCII as UTF-8", () => {
		expect(encodeQr("a").size).toBe(21);
		expect(utf8Bytes("é")).toEqual([0xc3, 0xa9]);
		// 44 bytes (é is two): 4 + 8 + 352 bits = 46 codewords, above the 44 of version 3.
		expect(encodeQr("https://music.ekaii.fr/bienvenue?qui=élodie").version).toBe(4);
	});
	it("darkModules lists every dark module once", () => {
		const dark = darkModules(m);
		expect(dark.length).toBeGreaterThan(100);
		expect(dark.length).toBe(m.modules.flat().filter(Boolean).length);
		expect(dark.some((p) => p.x === 0 && p.y === 0)).toBe(true);
	});
});
