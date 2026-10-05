// app.html: the page-view analytics script is optional (build-time PUBLIC_ANALYTICS_* variables) and is
// added only after the load event. It used to be a hard-coded <script defer src> to one particular analytics
// host: every install reported there, and an unreachable host held the load event of every page.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = readFileSync(fileURLToPath(new URL("./app.html", import.meta.url)), "utf8");

function loaderSource(): string {
	const m = html.match(/<script data-analytics-loader>([\s\S]*?)<\/script>/);
	if (!m) throw new Error("no <script data-analytics-loader> in app.html");
	return m[1];
}

// Renders the template the way SvelteKit does (%sveltekit.env.NAME% -> env[NAME] ?? "") and runs the loader
// against a minimal document / window.
function runLoader(env: Record<string, string>, readyState: "loading" | "complete") {
	const src = loaderSource().replace(/%sveltekit\.env\.([^%]+)%/g, (_m, name: string) => env[name] ?? "");
	const appended: Array<{ src: string; defer: boolean; attrs: Record<string, string> }> = [];
	const listeners: Record<string, Array<() => void>> = {};
	const document = {
		readyState,
		head: { appendChild: (el: { src: string; defer: boolean; attrs: Record<string, string> }) => appended.push(el) },
		createElement: () => {
			const el = { src: "", defer: false, attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { el.attrs[k] = v; } };
			return el;
		},
	};
	const window = { addEventListener: (type: string, fn: () => void) => (listeners[type] ||= []).push(fn) };
	new Function("document", "window", src)(document, window);
	return { appended, fireLoad: () => (listeners.load || []).forEach((fn) => fn()) };
}

describe("app.html analytics loader", () => {
	it("ships no hard-coded external script", () => {
		expect(html).not.toMatch(/<script[^>]*\ssrc=["']https?:/i);
		expect(html).not.toMatch(/stats\.eternel\.eu/);
	});

	it("adds nothing when the build sets no analytics variables", () => {
		const r = runLoader({}, "complete");
		r.fireLoad();
		expect(r.appended).toHaveLength(0);
	});

	it("adds nothing without a website id, or with a source that is not an http(s) URL", () => {
		const a = runLoader({ PUBLIC_ANALYTICS_SRC: "https://stats.example.org/script.js" }, "complete");
		const b = runLoader({ PUBLIC_ANALYTICS_SRC: "javascript:alert(1)", PUBLIC_ANALYTICS_WEBSITE_ID: "abc" }, "complete");
		expect(a.appended).toHaveLength(0);
		expect(b.appended).toHaveLength(0);
	});

	it("waits for the load event, then adds one deferred script with its attributes", () => {
		const env = { PUBLIC_ANALYTICS_SRC: "https://stats.example.org/script.js", PUBLIC_ANALYTICS_WEBSITE_ID: "site-1", PUBLIC_ANALYTICS_HOST: "https://stats.example.org" };
		const r = runLoader(env, "loading");
		expect(r.appended).toHaveLength(0);
		r.fireLoad();
		expect(r.appended).toEqual([{ src: env.PUBLIC_ANALYTICS_SRC, defer: true, attrs: { "data-website-id": "site-1", "data-host-url": "https://stats.example.org" }, setAttribute: expect.any(Function) }]);
	});

	it("adds it at once when the page has already loaded", () => {
		const r = runLoader({ PUBLIC_ANALYTICS_SRC: "https://stats.example.org/s.js", PUBLIC_ANALYTICS_WEBSITE_ID: "site-2" }, "complete");
		expect(r.appended).toHaveLength(1);
		expect(r.appended[0].attrs).toEqual({ "data-website-id": "site-2" });
	});
});
