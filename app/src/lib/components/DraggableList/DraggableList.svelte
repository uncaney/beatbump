<script
	lang="ts"
	generics="T extends Song | IListItemRenderer"
>
	// eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-imports
	import type { Song } from "$lib/types";

	// eslint-disable-next-line unused-imports/no-unused-imports, @typescript-eslint/no-unused-vars
	import type { IListItemRenderer } from "$lib/types/musicListItemRenderer";

	import Icon from "$components/Icon/Icon.svelte";
	import ListItem from "$components/ListItem/ListItem.svelte";
	import { SessionListService } from "$stores/list/sessionList";
	import { createEventDispatcher } from "svelte";

	// eslint-disable-next-line no-undef
	export let items: T[] = [];
	export let style = "";
	/** Touch: swipe a row left to reveal "Retirer" (dispatches `remove`). */
	export let swipeToRemove = false;
	/** Row that can never be swiped away (the playing track). */
	export let lockedIndex: number | null = null;

	const dispatch = createEventDispatcher<{
		click: void;
		dragstart: { event: DragEvent | PointerEvent; index: number };
		dragend: { event: DragEvent | PointerEvent; index: number };
		drag: { event: DragEvent; index: number };
		dragover: { event: DragEvent | PointerEvent; index: number };
		remove: { index: number; item: T };
	}>();

	let dragTimer: ReturnType<typeof setTimeout> | undefined;
	let isDragging = false;
	let currentDragId: number | null = null;
	let dragOverId: number | null = null;
	let dragY = 0;
	// Ghost offset: the mouse path keeps its historical 10rem; the touch path
	// centres the ghost on the finger (half a row).
	let ghostOffset = "10rem";
	// The playing track when a drag starts: after the in-place swaps the cursor
	// (position) must follow it, else the highlight and next() point at the
	// wrong row once a row crosses the current one.
	let dragCurrentTrack: T | null = null;

	const captureCurrent = () => {
		const s = $SessionListService;
		dragCurrentTrack = (s.mix[s.position] as T) ?? null;
	};
	const syncCursor = () => {
		if (!dragCurrentTrack) return;
		const idx = items.indexOf(dragCurrentTrack);
		dragCurrentTrack = null;
		if (idx >= 0 && idx !== $SessionListService.position) {
			SessionListService.updatePosition(idx);
		}
	};

	const finishDrag = () => {
		currentDragId = null;
		dragOverId = null;
		isDragging = false;
		ghostOffset = "10rem";
	};

	/** Swap the rows (and the session mix) the way the mouse path always did. */
	const commitSwap = () => {
		if (dragOverId !== null && currentDragId !== null) {
			[items[currentDragId], items[dragOverId]] = [
				items[dragOverId],
				items[currentDragId],
			];
			currentDragId = dragOverId;

			[
				$SessionListService.mix[currentDragId],
				$SessionListService.mix[dragOverId],
			] = [
				$SessionListService.mix[dragOverId],
				$SessionListService.mix[currentDragId],
			];
		}
		syncCursor();
	};

	// ---------------- Mouse: HTML5 drag and drop (unchanged) ----------------
	function handleDragStart(event: DragEvent, startId: number) {
		const target = event.target;
		event.dataTransfer?.setDragImage(new Image(), 0, 0);
		dragTimer = setTimeout(() => {
			currentDragId = startId;
			dragY = event.clientY;
			captureCurrent();
			dispatch("dragstart", { event, index: currentDragId });
			isDragging = true;
		}, 250);

		if (
			!target ||
			!("parentElement" in target) ||
			!(target.parentElement instanceof HTMLElement)
		)
			return;
	}

	function handleDragEnd(event: DragEvent) {
		if (dragTimer) {
			dispatch("click");
			clearTimeout(dragTimer);
			dragTimer = undefined;
		}
		commitSwap();
		dispatch("dragend", { event, index: currentDragId as number });
		finishDrag();
	}

	function handleDragOver(event: DragEvent, overId: number) {
		dragOverId = overId;
		if (overId === dragOverId) return;
		if ((dragOverId || overId) === null) return;
		dispatch("dragover", { event, index: currentDragId as number });
	}

	$: {
		if (dragOverId !== null && currentDragId !== null) {
			[items[currentDragId], items[dragOverId]] = [
				items[dragOverId],
				items[currentDragId],
			];

			currentDragId = dragOverId;
		}
	}

	// ---------------- Touch: Pointer Events ----------------
	// Long press (250 ms, no movement) = drag; horizontal travel >= 24 px with
	// |dx| > |dy| = swipe left to remove; anything else is left to the browser
	// (vertical scroll, `touch-action: pan-y`, which then fires pointercancel).
	const LONG_PRESS_MS = 250;
	const MOVE_SLOP = 8;
	const SWIPE_ENGAGE = 24;
	const SWIPE_OPEN = 96;

	type TouchMode = "idle" | "drag" | "swipe" | "cancel";
	let listEl: HTMLDivElement;
	let touch: {
		index: number;
		x: number;
		y: number;
		pointerId: number;
		el: HTMLElement;
		mode: TouchMode;
		timer?: ReturnType<typeof setTimeout>;
	} | null = null;
	let lastPointerType = "";
	let swipeIndex: number | null = null;
	let swipeX = 0;
	let openIndex: number | null = null;
	let suppressClick = false;

	$: touchBusy = touch?.mode === "drag" || touch?.mode === "swipe";

	const updateGhostY = (clientY: number) => {
		if (!listEl) return;
		const rect = listEl.getBoundingClientRect();
		dragY = listEl.scrollTop + (clientY - rect.top);
	};

	const rowIndexAt = (x: number, y: number): number | null => {
		const el = document.elementFromPoint(x, y)?.closest("[data-index]");
		if (!(el instanceof HTMLElement) || !listEl?.contains(el)) return null;
		const idx = Number(el.dataset.index);
		return Number.isInteger(idx) ? idx : null;
	};

	function onPointerDown(event: PointerEvent, index: number) {
		lastPointerType = event.pointerType;
		if (event.pointerType !== "touch") return;
		if (openIndex !== null && openIndex !== index) openIndex = null;
		const el = event.currentTarget as HTMLElement;
		if (touch?.timer) clearTimeout(touch.timer);
		touch = {
			index,
			x: event.clientX,
			y: event.clientY,
			pointerId: event.pointerId,
			el,
			mode: "idle",
		};
		touch.timer = setTimeout(() => {
			if (!touch || touch.mode !== "idle") return;
			touch.mode = "drag";
			touch = touch;
			try {
				el.setPointerCapture(event.pointerId);
			} catch {
				/* already captured or gone */
			}
			currentDragId = index;
			dragOverId = null;
			ghostOffset = `${Math.round(el.offsetHeight / 2)}px`;
			updateGhostY(event.clientY);
			captureCurrent();
			isDragging = true;
			try {
				navigator.vibrate?.(10);
			} catch {
				/* no haptics */
			}
			dispatch("dragstart", { event, index });
		}, LONG_PRESS_MS);
	}

	function onPointerMove(event: PointerEvent) {
		if (!touch || event.pointerId !== touch.pointerId) return;
		const dx = event.clientX - touch.x;
		const dy = event.clientY - touch.y;
		if (touch.mode === "idle") {
			if (
				swipeToRemove &&
				touch.index !== lockedIndex &&
				dx <= -SWIPE_ENGAGE &&
				Math.abs(dx) > Math.abs(dy)
			) {
				if (touch.timer) clearTimeout(touch.timer);
				touch.mode = "swipe";
				touch = touch;
				swipeIndex = touch.index;
				try {
					touch.el.setPointerCapture(event.pointerId);
				} catch {
					/* ignore */
				}
			} else if (Math.abs(dx) > MOVE_SLOP || Math.abs(dy) > MOVE_SLOP) {
				if (touch.timer) clearTimeout(touch.timer);
				touch.mode = "cancel";
				touch = touch;
				return;
			} else {
				return;
			}
		}
		if (touch.mode === "swipe") {
			swipeX = Math.min(0, dx);
			return;
		}
		if (touch.mode === "drag") {
			updateGhostY(event.clientY);
			const over = rowIndexAt(event.clientX, event.clientY);
			if (over !== null && over !== dragOverId) {
				dragOverId = over;
				dispatch("dragover", { event, index: currentDragId as number });
			}
		}
	}

	function onPointerUp(event: PointerEvent) {
		if (!touch || event.pointerId !== touch.pointerId) return;
		if (touch.timer) clearTimeout(touch.timer);
		const { mode, index, el } = touch;
		touch = null;
		if (mode === "drag") {
			suppressClick = true;
			commitSwap();
			dispatch("dragend", { event, index: currentDragId as number });
			finishDrag();
		} else if (mode === "swipe") {
			suppressClick = true;
			const travel = -swipeX;
			const commitAt = Math.max(SWIPE_OPEN * 1.5, el.offsetWidth * 0.4);
			swipeIndex = null;
			swipeX = 0;
			if (travel >= commitAt) {
				removeRow(index);
			} else if (travel >= SWIPE_OPEN / 2) {
				openIndex = index;
			} else {
				openIndex = null;
			}
		} else if (mode === "idle" && openIndex !== null) {
			// A plain tap elsewhere closes the open "Retirer" state.
			openIndex = null;
		}
	}

	function onPointerCancel(event: PointerEvent) {
		if (!touch || event.pointerId !== touch.pointerId) return;
		if (touch.timer) clearTimeout(touch.timer);
		const { mode } = touch;
		touch = null;
		if (mode === "drag") {
			// The browser took the gesture (scroll): keep whatever rows were
			// already swapped consistent, same as a drop would.
			commitSwap();
			dispatch("dragend", { event, index: currentDragId as number });
			finishDrag();
		} else if (mode === "swipe") {
			swipeIndex = null;
			swipeX = 0;
		}
	}

	function removeRow(index: number) {
		openIndex = null;
		const item = items[index];
		if (item === undefined) return;
		dispatch("remove", { index, item });
	}

	const rowTransform = (index: number, sx: number, si: number | null, oi: number | null) =>
		si === index
			? `translateX(${sx}px)`
			: oi === index
			? `translateX(-${SWIPE_OPEN}px)`
			: "";
	// Width of the red "Retirer" strip revealed behind the row.
	const rowReveal = (index: number, sx: number, si: number | null, oi: number | null) =>
		si === index ? Math.max(0, -sx) : oi === index ? SWIPE_OPEN : 0;
</script>

<div
	class="list"
	bind:this={listEl}
	style="overflow-y: {isDragging ? 'hidden' : 'auto'}; {style}"
>
	{#if currentDragId !== null}
		<div
			class="ghost"
			style="transform: translateY(calc({dragY}px - {ghostOffset})); pointer-events:none; {touchBusy
				? 'transition: none;'
				: ''}"
		>
			<ListItem
				item={items[currentDragId]}
				idx={currentDragId}
			/>
		</div>
	{/if}
	{#each items as item, index (item)}
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<div
			class="list-item"
			data-testid="queue-row"
			data-index={index}
			class:dragging={isDragging}
			class:drag-target={currentDragId === index}
			class:swiping={swipeIndex === index && swipeX <= -SWIPE_ENGAGE}
			class:open={openIndex === index}
			class:locked={lockedIndex === index}
			on:pointerdown={(event) => onPointerDown(event, index)}
			on:pointermove={onPointerMove}
			on:pointerup={onPointerUp}
			on:pointercancel={onPointerCancel}
			on:touchmove|nonpassive={(event) => {
				// Once a touch drag / swipe owns the gesture, the browser must
				// not start scrolling (touch-action is decided too early).
				if (touchBusy) event.preventDefault();
			}}
			on:contextmenu={(event) => {
				if (lastPointerType === "touch") event.preventDefault();
			}}
			on:click|capture={(event) => {
				if (!suppressClick) return;
				suppressClick = false;
				event.stopPropagation();
				event.preventDefault();
			}}
			on:drag={(event) => {
				const target = event.target;
				if (
					!target ||
					!("getBoundingClientRect" in target) ||
					typeof target.getBoundingClientRect !== "function"
				)
					return;
				if (
					target &&
					"parentElement" in target &&
					target.parentElement instanceof HTMLElement
				) {
					dragY = target.parentElement.scrollTop + event.clientY;
				}
			}}
			on:dragend={handleDragEnd}
			on:dragover|preventDefault={(event) => handleDragOver(event, index)}
			on:dragstart={(event) => {
				// Touch is handled with pointer events: never let a mobile
				// browser start a native drag on the long press.
				if (lastPointerType === "touch") {
					event.preventDefault();
					return;
				}
				handleDragStart(event, index);
			}}
		>
			<!-- Rendered only while a swipe reveals it: at rest the 0-width strip
			     (plus its padding) used to bleed a 10px red band down the desktop
			     queue, and the min-content button overflowed the panel. -->
			{#if swipeToRemove && rowReveal(index, swipeX, swipeIndex, openIndex) > 0}
				<div
					class="swipe-backdrop"
					aria-hidden={openIndex !== index}
					style:width="{rowReveal(index, swipeX, swipeIndex, openIndex)}px"
					style:transition={swipeIndex === index ? "none" : "width 180ms ease-out"}
				>
					<button
						type="button"
						class="swipe-remove"
						data-testid="queue-row-remove"
						aria-label="Retirer de la file d'attente"
						title="Retirer de la file d'attente"
						tabindex={openIndex === index ? 0 : -1}
						on:pointerdown|stopPropagation={() => {}}
						on:click|stopPropagation={() => removeRow(index)}
					>
						<Icon
							name="trash"
							size="1.1em"
							color="currentColor"
						/>
						<span>Retirer</span>
					</button>
				</div>
			{/if}
			<div
				class="row-content"
				style:transform={rowTransform(index, swipeX, swipeIndex, openIndex)}
				style:transition={swipeIndex === index ? "none" : "transform 180ms ease-out"}
			>
				<slot
					name="item"
					{item}
					{index}
				/>
			</div>
		</div>
	{/each}
</div>

<style lang="scss">
	.list {
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		position: relative;
		// max-height: 100%;
		min-height: 100%;
		height: 100%;
		max-width: 100%;
		visibility: visible;
	}
	.list-item {
		position: relative;
		// Vertical scroll stays native; horizontal travel reaches the swipe
		// handler; the long press is ours (no callout / text selection).
		touch-action: pan-y;
		-webkit-touch-callout: none;
		@media (hover: none) {
			user-select: none;
			-webkit-user-select: none;
		}
	}
	.drag-target {
		opacity: 0;
	}
	.list-item.dragging,
	:global(.list-item.dragging > *) {
		-webkit-touch-callout: none !important;
		-webkit-user-select: none !important;
		-webkit-user-drag: none !important;
		-khtml-user-select: none !important;
		-moz-user-select: none !important;
		-ms-user-select: none !important;
		user-select: none !important;
		touch-action: none;
	}
	.row-content {
		position: relative;
		z-index: 1;
		background: inherit;
		will-change: transform;
	}
	.swipe-backdrop {
		position: absolute;
		top: 0;
		bottom: 0;
		right: 0;
		width: 0;
		// no padding: with border-box a 0-width strip still rendered its padding
		padding: 0;
		overflow: hidden;
		box-sizing: border-box;
		background: #c62828;
		color: #fff;
		pointer-events: none;
	}
	.list-item.open .swipe-backdrop {
		pointer-events: auto;
	}
	// Absolutely positioned inside the clipped backdrop: it no longer sets the
	// strip's min-content width, and is revealed progressively by the swipe.
	// The `!important`s beat the global `button` rule (dark text on light
	// background), which measured "Retirer" at 2.01:1 on the red strip.
	.swipe-remove {
		position: absolute;
		right: 0.75em;
		top: 50%;
		transform: translateY(-50%);
		display: inline-flex;
		align-items: center;
		gap: 0.4em;
		min-width: 5.5em;
		min-height: 2.75em;
		padding: 0.4em 0.8em;
		border: 0 !important;
		border-radius: 999px;
		background: hsla(0, 0%, 0%, 0.3) !important;
		color: #fff !important;
		text-transform: none !important;
		box-shadow: none !important;
		white-space: nowrap;
		font-weight: 600;
		font-size: 0.9em;
		cursor: pointer;
		&:hover,
		&:focus,
		&:active {
			background: hsla(0, 0%, 0%, 0.45) !important;
			color: #fff !important;
		}
		&:focus-visible {
			outline: 2px solid #fff;
			outline-offset: 2px;
		}
	}
	.ghost {
		position: absolute;
		top: 0;
		transition: transform 280ms cubic-bezier(0.23, 1, 0.32, 1);
		// background-color:  !important;
		:global(& + *) {
			// background-color: red !important;
		}
		opacity: 0.4;
		left: 0;
		will-change: transform, top;
		width: 100%;
		pointer-events: none;
	}
</style>
