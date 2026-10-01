/**
 * Pure gesture decisions for DraggableList (pointer events for mouse, pen
 * and touch; no native HTML5 drag and drop).
 *
 * - Grip (`.drag-handle`), any pointer: the drag starts on pointerdown.
 * - Row, mouse / pen: the drag starts after a 250 ms hold or 6 px of travel.
 * - Row, touch: long press (250 ms, no travel); travel instead either opens
 *   the swipe-to-remove (leftwards, mostly horizontal) or hands the gesture
 *   back to the browser (vertical scroll).
 */

export const HOLD_MS = 250;
export const MOUSE_SLOP = 6;
export const TOUCH_SLOP = 8;
export const SWIPE_ENGAGE = 24;

/** ms before a press becomes a drag: at once from the grip, else a hold. */
export const holdDelay = (fromHandle: boolean): number => (fromHandle ? 0 : HOLD_MS);

export type IdleOutcome = "none" | "drag" | "swipe" | "cancel";

/**
 * What a move does while the press is not a drag yet (`dx`, `dy` = travel
 * since pointerdown). Mouse / pen: 6 px of travel starts the drag. Touch:
 * a leftward, mostly horizontal travel of 24 px opens the swipe (when the
 * row can be swiped away), more than 8 px of any other travel cancels the
 * press (the browser scrolls).
 */
export function idleMove(pointerType: string, dx: number, dy: number, canSwipe: boolean): IdleOutcome {
	if (pointerType !== "touch") {
		return Math.hypot(dx, dy) >= MOUSE_SLOP ? "drag" : "none";
	}
	if (canSwipe && dx <= -SWIPE_ENGAGE && Math.abs(dx) > Math.abs(dy)) return "swipe";
	if (Math.abs(dx) > TOUCH_SLOP || Math.abs(dy) > TOUCH_SLOP) return "cancel";
	return "none";
}

/**
 * Whether the click that follows the release must be swallowed (it would
 * otherwise play the row under the pointer). A drag started from the grip
 * always swallows it; a drag started from the row only once it moved a row
 * (a mouse hold released in place stays a click).
 */
export function swallowClick(pointerType: string, fromHandle: boolean, moved: boolean): boolean {
	if (pointerType === "touch") return true;
	return fromHandle || moved;
}

/** `list` with the row at `from` moved to `to` (a new array; out of range = copy). */
export function moveIndex<T>(list: readonly T[], from: number, to: number): T[] {
	const next = list.slice();
	if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
	const [row] = next.splice(from, 1);
	next.splice(to, 0, row);
	return next;
}

/** Keyboard reorder (Alt+ArrowUp / Alt+ArrowDown): the target index, or null. */
export function keyTarget(key: string, index: number, length: number): number | null {
	const to = key === "ArrowUp" ? index - 1 : key === "ArrowDown" ? index + 1 : NaN;
	return Number.isInteger(to) && to >= 0 && to < length ? to : null;
}
