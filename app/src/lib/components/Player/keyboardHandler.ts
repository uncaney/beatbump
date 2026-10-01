// Global keyboard shortcuts for the player (brainstorm T1).
//
// `shortcut` maps either an `event.code` ("Space", "KeyJ", "ArrowLeft"…) or an
// `event.key` ("?", "/") to a handler. Matching by key lets "?" and "/" work on
// every layout (AZERTY: Shift+, and Shift+:), so Shift is only tolerated for
// key-matched entries; Ctrl / Alt / Meta combos are never captured.
//
// Shortcuts are ignored while typing (input, textarea, select, contenteditable)
// and while a dropdown menu has focus. Keys that have a native meaning on a
// focused control (Space, Enter, arrows on a button / link / tabindex element)
// are left to the browser, as before.
type Handler = (event: KeyboardEvent) => void;
export type ShortcutMap = Record<string, Handler | Handler[]>;

const NATIVE_ON_CONTROLS = /^(Space|Enter|NumpadEnter|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/;

function isTyping(el: Element | null): boolean {
	if (!el) return false;
	if (/^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) return true;
	return (el as HTMLElement).isContentEditable === true;
}

function isControl(el: Element | null): boolean {
	if (!el) return false;
	return (
		/^(BUTTON|A)$/i.test(el.tagName) ||
		el.attributes.getNamedItem("tabindex") !== null ||
		el.classList.contains("select") ||
		el.classList.contains("dd-menu") ||
		el.classList.contains("dd-item") ||
		el.classList.contains("dd-button")
	);
}

export default function keyboardHandler(
	node: Node,
	params: { shortcut: ShortcutMap },
): SvelteActionReturnType {
	function keyDown(event: KeyboardEvent) {
		const map = params.shortcut;
		// Key first: on AZERTY "?" is Shift+Comma, and "Comma" is itself mapped.
		const byKey = Object.prototype.hasOwnProperty.call(map, event.key);
		const byCode = !byKey && Object.prototype.hasOwnProperty.call(map, event.code);
		if (!byCode && !byKey) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.shiftKey && !byKey) return;
		if (event.key.match(/^F[1-9][0-9]?$/) || event.code === "Tab") return;

		const active = document.activeElement;
		if (isTyping(active)) return;
		if (
			active &&
			active.classList &&
			(active.classList.contains("dd-menu") ||
				active.classList.contains("dd-item") ||
				active.classList.contains("dd-button"))
		)
			return;
		if (isControl(active) && NATIVE_ON_CONTROLS.test(event.code)) return;

		event.preventDefault();
		const handler = map[byCode ? event.code : event.key];
		if (Array.isArray(handler)) {
			handler.forEach((fn) => fn(event));
		} else if (typeof handler === "function") {
			handler(event);
		}
	}
	window.addEventListener("keydown", keyDown);
	return {
		update(next: { shortcut: ShortcutMap }) {
			params = next;
		},
		destroy() {
			window.removeEventListener("keydown", keyDown);
		},
	};
}
