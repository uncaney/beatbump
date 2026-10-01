import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rollup } from "rollup";
import { resolveRuntimeDir, runtimeSurface, svelteManualChunk, svelteRuntimeChunk } from "../../scripts/svelteRuntimeChunk";

const appRoot = path.resolve(__dirname, "../..");

describe("PF4-1: stable svelte-runtime chunk", () => {
	it("re-exports the runtime minus the dev and ssr helpers", () => {
		const src = "export * from './dom.js';\nexport * from './ssr.js';\nexport * from \"./scheduler.js\";\nexport * from './dev.js';\n";
		expect(runtimeSurface(src)).toEqual(["dom.js", "scheduler.js"]);
		const dir = resolveRuntimeDir(appRoot);
		expect(dir).toBeTruthy();
		const real = runtimeSurface(fs.readFileSync(path.join(dir!, "index.js"), "utf8"));
		expect(real).toContain("dom.js");
		expect(real).toContain("Component.js");
		expect(real).not.toContain("dev.js");
	});

	it("routes svelte modules and the runtime entry to one chunk", () => {
		expect(svelteManualChunk("/app/node_modules/svelte/src/runtime/internal/dom.js")).toBe("svelte-runtime");
		expect(svelteManualChunk("\0ytm-svelte-runtime.js")).toBe("svelte-runtime");
		expect(svelteManualChunk("/app/src/lib/x.ts")).toBeUndefined();
	});

	// Two "builds" of a toy app (plain Rollup, real svelte runtime): the
	// second one stops using a helper. Without the plugin the runtime chunk
	// and every unchanged importer are renamed; with it only the changed
	// module is.
	it("keeps the runtime and unchanged importers' names when the helper set changes", async () => {
		const dir = resolveRuntimeDir(appRoot)!;
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rt-chunk-"));
		const rt = JSON.stringify(path.join(dir, "index.js"));
		fs.writeFileSync(path.join(tmp, "a.js"), `import { insert, noop } from ${rt}; export const a = () => insert && noop;`);
		const build = async (useEip: boolean, stable: boolean) => {
			fs.writeFileSync(
				path.join(tmp, "b.js"),
				useEip ? `import { detach, exclude_internal_props } from ${rt}; export const b = () => detach && exclude_internal_props;` : `import { detach } from ${rt}; export const b = () => detach;`,
			);
			const bundle = await rollup({
				input: { a: path.join(tmp, "a.js"), b: path.join(tmp, "b.js") },
				plugins: stable ? [svelteRuntimeChunk({ root: appRoot, force: true })] : [],
				onwarn: () => {},
			});
			const { output } = await bundle.generate({
				format: "es",
				entryFileNames: "entry/[name].[hash].js",
				chunkFileNames: "chunks/[name].[hash].js",
				minifyInternalExports: !stable,
				// the plugin adds the svelte rule in front of this one
				manualChunks: (id) => (id.includes("/hls/") ? "hls" : undefined),
			});
			await bundle.close();
			const rtChunk = output.find((o) => o.type === "chunk" && o.fileName.includes("svelte-runtime"));
			if (rtChunk && rtChunk.type === "chunk") rtExports = rtChunk.exports;
			return output.map((o) => o.fileName).sort();
		};
		let rtExports: string[] = [];
		try {
			const plain = [await build(true, false), await build(false, false)];
			const plainKept = plain[1].filter((f) => plain[0].includes(f));
			expect(plainKept.length).toBeLessThan(plain[1].length - 1); // more than b changed

			const stable = [await build(true, true), await build(false, true)];
			const kept = stable[1].filter((f) => stable[0].includes(f));
			expect(stable[1].some((f) => /^chunks\/svelte-runtime\.[\w-]+\.js$/.test(f))).toBe(true);
			expect(kept.length).toBe(stable[1].length - 1); // only b renamed
			expect(stable[1].filter((f) => !kept.includes(f))).toEqual([expect.stringMatching(/^entry\/b\./)]);
			// the whole client surface, readable names, no dev / ssr helper
			for (const name of ["insert", "detach", "exclude_internal_props", "init", "SvelteComponent", "writable", "fade", "cubicOut", "flip", "spring"]) {
				expect(rtExports).toContain(name);
			}
			expect(rtExports).not.toContain("dispatch_dev");
			expect(rtExports).not.toContain("create_ssr_component");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
