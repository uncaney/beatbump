import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installHintDock, installHintGeometry, installHintReserve } from "./dock";

describe("installHintDock (UX5)", () => {
	it("docks above the mini-player when one is shown", () => {
		expect(installHintDock(true)).toBe("above-player");
		expect(installHintGeometry("above-player")).toEqual({
			bottom: "var(--player-bar-height, 0px)",
			safeArea: "0px",
		});
	});

	it("docks on the bottom edge with the safe-area inset without a player", () => {
		expect(installHintDock(false)).toBe("bottom");
		const g = installHintGeometry("bottom");
		expect(g.bottom).toBe("0px");
		expect(g.safeArea).toContain("safe-area-inset-bottom");
	});

	it("stays above a bottom nav when one is given", () => {
		expect(installHintGeometry("bottom", "56px").bottom).toBe("56px");
	});

	it("the component never docks at the top (over the nav or a page title)", () => {
		const src = readFileSync(fileURLToPath(new URL("./InstallHint.svelte", import.meta.url)), "utf8");
		const style = src.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "";
		expect(src).not.toMatch(/docked-top/);
		expect(style).not.toMatch(/(^|[\s;{])top\s*:/);
		expect(src).toMatch(/data-testid="install-hint"/);
		expect(src).toMatch(/class="btn-primary install"/);
		expect(src).toMatch(/aria-label="Plus tard"/);
	});
});

describe("installHintReserve (L10-14: the strip never covers the last row)", () => {
	it("reserves the measured strip height while shown", () => {
		expect(installHintReserve(true, 52.4)).toBe("53px");
		expect(installHintReserve(false, 52)).toBeNull();
		expect(installHintReserve(true, 0)).toBeNull();
	});
	it("InstallHint applies it to the end of main", () => {
		const src = readFileSync(fileURLToPath(new URL("./InstallHint.svelte", import.meta.url)), "utf8");
		expect(src).toContain("--install-hint-reserve");
		expect(src).toMatch(/:global\(html\[data-install-hint\] main\)/);
	});
});
