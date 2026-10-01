import { describe, expect, it } from "vitest";
import { isNavigationKey, shouldTypeaheadOnKeyup } from "./typeaheadKeys";

describe("H7b: typeahead only on a changed query", () => {
	it("knows the navigation / modifier keys", () => {
		for (const k of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Shift", "Control", "Meta", "Escape", "Enter", "Tab", "F5"]) {
			expect(isNavigationKey(k), k).toBe(true);
		}
		for (const k of ["a", "A", " ", "Backspace", "Delete", "1", "é", "Unidentified", undefined]) {
			expect(isNavigationKey(k), String(k)).toBe(false);
		}
	});
	it("arrow keys never re-fire the lookup", () => {
		expect(shouldTypeaheadOnKeyup("ArrowDown", "daft", "daf")).toBe(false);
		expect(shouldTypeaheadOnKeyup("ArrowUp", "daft", "")).toBe(false);
		expect(shouldTypeaheadOnKeyup("Shift", "Daft", "daft")).toBe(false);
	});
	it("a typed character fires only when the text changed", () => {
		expect(shouldTypeaheadOnKeyup("t", "daft", "daf")).toBe(true);
		expect(shouldTypeaheadOnKeyup("Backspace", "daf", "daft")).toBe(true);
		expect(shouldTypeaheadOnKeyup("Backspace", "", "d")).toBe(true); // clears the suggestions
		expect(shouldTypeaheadOnKeyup("t", "daft", "daft")).toBe(false); // keyup after a repeat / IME commit
		expect(shouldTypeaheadOnKeyup("Unidentified", "daft", "daf")).toBe(true); // mobile keyboards report Unidentified
	});
});
