// c48c B8-23: build-time guard against the TDZ import-cycle class (chains 45/46,
// L13-11; see the end of stores/list/sessionList.ts and stores/stores.ts).
// Two modules on an import cycle are evaluated in an order that depends on
// the entry point (dynamic-import entries such as sleepTimer / resumeState /
// nowPlayingSync reach player.ts before sessionList.ts): a module that uses a
// binding of another cycle member AT MODULE LEVEL (`list.subscribe(...)`,
// `derived(settings, ...)`) throws "Cannot access 'x' before initialization"
// when it is evaluated first. vitest (Node) never sees it: only the real
// navigation does. This test parses the static imports of app/src/lib/**/*.ts,
// finds the cycles (Tarjan) and FAILS when a member of a cycle uses, in a
// statement outside any function / class body, a binding imported from
// another member: `name(`, `name.subscribe(` / `.set(` / `.update(`,
// `get(name)` or `derived(... name ...)` (the part of the statement before
// its first `=>` only: a use inside a callback is deferred, not a TDZ).
// Cheap heuristic, no whitelist: the fix is a lazy getter (stores.ts
// `fromSettings`, cycle 46) or moving the subscription where the store is
// defined (sessionList.ts, chain 45).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LIB_DIR = __dirname;
const SRC_DIR = path.resolve(LIB_DIR, "..");

type Import = { spec: string; names: string[] };

function listTs(dir: string): string[] {
	const out: string[] = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === "node_modules") continue;
			out.push(...listTs(p));
		} else if (ent.isFile() && p.endsWith(".ts") && !p.endsWith(".d.ts") && !/\.(test|spec)\.ts$/.test(p)) {
			out.push(p);
		}
	}
	return out.sort();
}

/** Comments out (block and line), strings and template literals blanked so braces / parens inside them do not count. */
function stripCommentsAndStrings(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, pre) => pre)
		.replace(/`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/g, (m) => '"' + m.slice(1, -1).replace(/[^\n]/g, " ") + '"')
		.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}

/** Static imports only: `import x from`, `import {a as b} from`, `import * as ns from`, `import "x"`, `export ... from`; `import type` and `import()` ignored. */
function parseImports(src: string): Import[] {
	const out: Import[] = [];
	const clean = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
	const re = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(clean))) {
		if (m[5]) {
			out.push({ spec: m[5], names: [] });
			continue;
		}
		const spec = m[4];
		if (m[2] || m[1] === "export") {
			out.push({ spec, names: [] });
			continue;
		}
		const clause = m[3].trim();
		const names: string[] = [];
		const braces = clause.match(/\{([\s\S]*)\}/);
		if (braces) {
			for (const part of braces[1].split(",")) {
				const p = part.trim();
				if (!p || /^type\s/.test(p)) continue;
				const as = p.match(/^[\w$]+\s+as\s+([\w$]+)$/);
				names.push(as ? as[1] : p);
			}
		}
		const rest = clause.replace(/\{[\s\S]*\}/, "").trim();
		const ns = rest.match(/\*\s+as\s+([\w$]+)/);
		if (ns) names.push(ns[1]);
		const def = rest.replace(/\*\s+as\s+[\w$]+/, "").replace(/,/g, " ").trim();
		if (def && /^[\w$]+$/.test(def)) names.push(def);
		out.push({ spec, names });
	}
	return out;
}

const ALIASES: Array<[string, string]> = [
	["$lib/", path.join(SRC_DIR, "lib") + "/"],
	["$stores/", path.join(SRC_DIR, "lib", "stores") + "/"],
	["$components/", path.join(SRC_DIR, "lib", "components") + "/"],
];

/** The .ts file a specifier points to (aliases above, "./", "../"); null for packages, virtual modules, .svelte and files outside the graph. */
function resolveSpec(fromFile: string, spec: string, nodes: Set<string>): string | null {
	let base: string | null = null;
	for (const [prefix, dir] of ALIASES) if (spec.startsWith(prefix)) base = dir + spec.slice(prefix.length);
	if (!base && (spec.startsWith("./") || spec.startsWith("../"))) base = path.resolve(path.dirname(fromFile), spec);
	if (!base) return null;
	const candidates = [base, base.replace(/\.js$/, ".ts"), base + ".ts", path.join(base, "index.ts")];
	for (const c of candidates) if (nodes.has(c)) return c;
	return null;
}

/** Tarjan: the strongly connected components of size > 1 (a self-import counts as a cycle too). */
function cycles(graph: Map<string, Set<string>>): string[][] {
	let index = 0;
	const idx = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const out: string[][] = [];
	const visit = (v: string) => {
		idx.set(v, index);
		low.set(v, index);
		index++;
		stack.push(v);
		onStack.add(v);
		for (const w of graph.get(v) ?? []) {
			if (!idx.has(w)) {
				visit(w);
				low.set(v, Math.min(low.get(v)!, low.get(w)!));
			} else if (onStack.has(w)) {
				low.set(v, Math.min(low.get(v)!, idx.get(w)!));
			}
		}
		if (low.get(v) === idx.get(v)) {
			const comp: string[] = [];
			let w: string;
			do {
				w = stack.pop()!;
				onStack.delete(w);
				comp.push(w);
			} while (w !== v);
			if (comp.length > 1 || graph.get(v)?.has(v)) out.push(comp.sort());
		}
	};
	for (const v of [...graph.keys()].sort()) if (!idx.has(v)) visit(v);
	return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does this top-level statement (its part before the first `=>`) use `name` like a value at module evaluation? */
function statementUses(statement: string, name: string): boolean {
	const code = statement.split("=>")[0];
	const n = esc(name);
	if (new RegExp(`(^|[^\\w$.])${n}\\s*\\(`).test(code)) return true;
	if (new RegExp(`(^|[^\\w$.])${n}\\s*\\.\\s*(subscribe|set|update)\\s*\\(`).test(code)) return true;
	if (new RegExp(`\\bget\\s*\\(\\s*${n}\\s*\\)`).test(code)) return true;
	if (/\bderived\s*(<[^>]*>)?\s*\(/.test(code) && new RegExp(`(^|[^\\w$.])${n}(?![\\w$])`).test(code.replace(/<[^>]*>/g, ""))) return true;
	return false;
}

export type Offender = { line: number; name: string; statement: string };

/**
 * Top-level uses of `names` in `src`: statements outside any function / class
 * body (blocks opened by `function`, `=>`, `class` or a method head are
 * skipped, `if` / `try` blocks at module level are not), joined across lines
 * while their parentheses are open, then checked by `statementUses`.
 */
function topLevelUses(src: string, names: string[]): Offender[] {
	const out: Offender[] = [];
	if (!names.length) return out;
	const lines = stripCommentsAndStrings(src).split("\n");
	const fnStack: boolean[] = [];
	let buf = "";
	let bufStart = 0;
	let depth = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const inFn = fnStack.some(Boolean);
		if (!inFn) {
			if (!buf) bufStart = i + 1;
			buf += (buf ? "\n" : "") + line;
			for (const ch of line) {
				if (ch === "(") depth++;
				else if (ch === ")") depth--;
			}
			if (depth <= 0) {
				const stmt = buf.trim();
				if (stmt && !/^(import\b|export\s+(type|\{|\*)|type\s|interface\s|declare\s|(export\s+)?(default\s+)?(async\s+)?(function\b|class\b))/.test(stmt)) {
					for (const name of names) if (statementUses(stmt, name)) out.push({ line: bufStart, name, statement: stmt.replace(/\s+/g, " ").slice(0, 160) });
				}
				buf = "";
				depth = 0;
			}
		} else {
			buf = "";
			depth = 0;
		}
		// Block tracking: each "{" opens a function body when the text since the previous brace boundary says so.
		let seg = "";
		for (const ch of line) {
			if (ch === "{") {
				// A method head `name(args) {` (class / object), never a control block `if (...) {`.
				const opensFn =
					/\bfunction\b|=>|\bclass\b/.test(seg) ||
					/(^|[\s,;{(])(?:(?:public|private|protected|static|async|get|set|readonly)\s+)*(?!(?:if|for|while|switch|catch|with|return)\b)[\w$]+\s*(<[^>]*>)?\s*\([^()]*\)\s*(:\s*[^{]*)?$/.test(seg.trimEnd());
				fnStack.push(opensFn);
				seg = "";
			} else if (ch === "}") {
				fnStack.pop();
				seg = "";
			} else {
				seg += ch;
			}
		}
	}
	return out;
}

function buildGraph(): { nodes: string[]; graph: Map<string, Set<string>>; imports: Map<string, Import[]> } {
	const nodes = listTs(LIB_DIR);
	const set = new Set(nodes);
	const graph = new Map<string, Set<string>>();
	const imports = new Map<string, Import[]>();
	for (const f of nodes) {
		const src = fs.readFileSync(f, "utf8");
		const imps = parseImports(src);
		imports.set(f, imps);
		const edges = new Set<string>();
		for (const imp of imps) {
			const to = resolveSpec(f, imp.spec, set);
			if (to && to !== f) edges.add(to);
		}
		graph.set(f, edges);
	}
	return { nodes, graph, imports };
}

const rel = (f: string) => path.relative(SRC_DIR, f);

describe("import cycles (B8-23, TDZ guard)", () => {
	const { nodes, graph, imports } = buildGraph();
	const sccs = cycles(graph);

	it("parses the lib tree and finds its known cycles (player <-> sessionList, settings <-> stores)", () => {
		expect(nodes.length).toBeGreaterThan(50);
		const members = new Set(sccs.flat().map(rel));
		expect(members.has("lib/player.ts")).toBe(true);
		expect(members.has("lib/stores/list/sessionList.ts")).toBe(true);
		expect(members.has("lib/stores/settings.ts")).toBe(true);
		expect(members.has("lib/stores/stores.ts")).toBe(true);
	});

	it("no module of a cycle uses a binding of another member at module level", () => {
		const report: string[] = [];
		for (const comp of sccs) {
			const inCycle = new Set(comp);
			for (const f of comp) {
				const names: string[] = [];
				for (const imp of imports.get(f) ?? []) {
					const to = resolveSpec(f, imp.spec, new Set(nodes));
					if (to && to !== f && inCycle.has(to)) names.push(...imp.names);
				}
				for (const o of topLevelUses(fs.readFileSync(f, "utf8"), names)) {
					report.push(`${rel(f)}:${o.line} uses \`${o.name}\` at module level (cycle of ${comp.length}: ${comp.map(rel).join(", ")}): ${o.statement}`);
				}
			}
		}
		expect(report, "TDZ risk: move the use into a lazy getter or a function (see sessionList.ts / stores.ts)\n" + report.join("\n")).toEqual([]);
	});
});

describe("the heuristic itself", () => {
	it("flags module-level subscribe / derived / call / get uses, across lines and inside module-level if blocks", () => {
		const src = [
			'import { list, settings, foo } from "./x";',
			"list.subscribe((state) => sleepQueueChanged(state));",
			"export const theme = derived(settings, ($s) => $s.appearance.Theme);",
			"const q = derived<typeof list, number>(",
			"\tlist,",
			"\t($l, set) => set($l.position),",
			");",
			'if (browser && globalThis.self.name !== "IDB" && settings) {',
			"\tsettings.subscribe((v) => (userSettings = v));",
			"}",
			"export const initial = get(settings);",
			"export const n = foo(1);",
		].join("\n");
		const hits = topLevelUses(src, ["list", "settings", "foo"]).map((o) => `${o.line}:${o.name}`);
		expect(hits).toEqual(["2:list", "3:settings", "4:list", "9:settings", "11:settings", "12:foo"]);
	});

	it("ignores uses inside functions, arrow bodies, class methods, lazy getters, callbacks and types", () => {
		const src = [
			'import { list, settings, derived } from "./x";',
			"function wire() {",
			"\tlist.subscribe(() => {});",
			"\tif (settings) settings.subscribe(() => {});",
			"}",
			"const lazy = () => {",
			"\treturn derived(settings, (s) => s);",
			"};",
			"function fromSettings(pick) {",
			"\tlet inner = null;",
			"\treturn { subscribe: (run, invalidate) => (inner ??= derived(settings, pick)).subscribe(run, invalidate) };",
			"}",
			"class Svc {",
			"\tstart() {",
			"\t\tlist.subscribe(() => {});",
			"\t}",
			"\tprivate async load(): Promise<void> {",
			"\t\tsettings.update((s) => s);",
			"\t}",
			"}",
			"SessionListService.subscribe((state) => list.get(state));",
			"let a: typeof list;",
			"export { list };",
			'const s = "list.subscribe(" + "settings(";',
		].join("\n");
		expect(topLevelUses(src, ["list", "settings"])).toEqual([]);
	});

	it("parses the import forms it needs and skips type-only ones", () => {
		const src = [
			'import def, { a, b as c, type T } from "$lib/x";',
			'import * as ns from "./y";',
			'import type { U } from "./z";',
			'import "./side";',
			'export { e } from "../w";',
			'const later = import("./dyn");',
		].join("\n");
		expect(parseImports(src)).toEqual([
			{ spec: "$lib/x", names: ["a", "c", "def"] },
			{ spec: "./y", names: ["ns"] },
			{ spec: "./z", names: [] },
			{ spec: "./side", names: [] },
			{ spec: "../w", names: [] },
		]);
	});

	it("finds strongly connected components", () => {
		const g = new Map<string, Set<string>>([
			["a", new Set(["b"])],
			["b", new Set(["c"])],
			["c", new Set(["a", "d"])],
			["d", new Set()],
			["e", new Set(["e"])],
		]);
		expect(cycles(g)).toEqual([["e"], ["a", "b", "c"]].sort());
	});
});
