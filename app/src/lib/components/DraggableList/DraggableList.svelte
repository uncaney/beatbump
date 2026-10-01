<script
	lang="ts"
	generics="T extends Song | IListItemRenderer"
>
	// eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-imports
	import type { Item, Song } from "$lib/types";

	// eslint-disable-next-line unused-imports/no-unused-imports, @typescript-eslint/no-unused-vars
	import type { IListItemRenderer } from "$lib/types/musicListItemRenderer";

	import Icon from "$components/Icon/Icon.svelte";
	import ListItem from "$components/ListItem/ListItem.svelte";
	import { SessionListService } from "$stores/list/sessionList";
	import { planDragCommit } from "$stores/list/queueOps";
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
	// The playing track when a drag starts (lists other than the queue): after
	// the in-place swaps the cursor (position) must follow it, else the
	// highlight and next() point at the wrong row once a row crosses the
	// current one.
	let dragCurrentTrack: T | null = null;
	// True while the queue itself is being dragged (`items` is the session
	// mix). The swaps then happen on a private copy and the queue is replaced
	// once, on drop, through SessionListService.reorder(): the store setter
	// runs (subscribers, tab sync) and the warm next-track URL is refreshed, so
	// "suivant" plays the new neighbour (G1). Before, the shared array was
	// swapped in place and no subscriber ever heard of it.
	let queueDrag = false;
	// Queue drag (H4): the parent re-pushes `items` (= the store mix) on every
	// store emission (track change, continuation), so the swaps live in
	// `dragItems`, rendered instead of `items` while the drag lasts; `dragBase`
	// is the queue at drag start and `dragRow` the dragged row. On drop the
	// fresh queue is compared with `dragBase` (planDragCommit): unchanged, the
	// copy is committed; changed, the single move is rebased on the fresh
	// queue or the reorder is dropped with a warning, never a stale overwrite.
	let dragItems: T[] = [];
	let dragBase: T[] = [];
	let dragRow: T | null = null;
	$: rows = queueDrag ? dragItems : items;

	const captureCurrent = (startIndex: number) => {
		const s = $SessionListService;
		queueDrag = (items as unknown) === s.mix;
		if (queueDrag) {
			dragBase = items.slice();
			dragItems = items.slice();
			dragRow = items[startIndex] ?? null;
		}
		dragCurrentTrack = (s.mix[s.position] as T) ?? null;
	};
	const swapRows = (a: number, b: number) => {
		if (queueDrag) {
			[dragItems[a], dragItems[b]] = [dragItems[b], dragItems[a]];
			dragItems = dragItems;
		} else {
			[items[a], items[b]] = [items[b], items[a]];
			items = items;
		}
	};
	const syncCursor = () => {
		if (queueDrag) {
			const fresh = $SessionListService.mix as unknown as T[];
			const commit = planDragCommit(dragBase, dragItems, dragRow, fresh);
			queueDrag = false;
			dragCurrentTrack = null;
			dragItems = [];
			dragBase = [];
			dragRow = null;
			if (commit.kind === "abort") {
				console.warn("[queue] reorder dropped: the queue changed during the drag");
			} else if (commit.kind === "apply") {
				if (commit.rebased) console.warn("[queue] queue changed during the drag: move rebased on the fresh queue");
				if (!SessionListService.reorder(commit.mix as unknown as Item[])) {
					console.warn("[queue] reorder refused: not a permutation of the current queue");
				}
			}
			return;
		}
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

	/** Swap the rows the way the mouse path always did, then hand the result over. */
	const commitSwap = () => {
		if (dragOverId !== null && currentDragId !== null) {
			swapRows(currentDragId, dragOverId);
			currentDragId = dragOverId;
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
			captureCurrent(startId);
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
			swapRows(currentDragId, dragOverId);
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
		// The visible grip (.drag-handle, touch-action none) starts the drag at
		// once; anywhere else on the row keeps the long press.
		const fromHandle = !!(event.target as Element | null)?.closest?.(".drag-handle");
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
			captureCurrent(index);
			isDragging = true;
			try {
				navigator.vibrate?.(10);
			} catch {
				/* no haptics */
			}
			dispatch("dragstart", { event, index });
		}, fromHandle ? 0 : LONG_PRESS_MS);
	}

	// Keyboard (audit v4 3.7 / TOP 9): ListItem only renders its kebab while
	// "hovered" (pointerenter). A row that receives focus gets the same
	// signal, so Tab reaches "Plus d'options" without a mouse; the row that
	// loses focus to another row of the list is released.
	const rowArticle = (row: EventTarget | null) =>
		row instanceof HTMLElement ? row.querySelector<HTMLElement>(".m-item") : null;
	function onRowFocusIn(event: FocusEvent) {
		const art = rowArticle(event.currentTarget);
		if (art && !art.matches(":hover")) art.dispatchEvent(new PointerEvent("pointerenter"));
	}
	function onRowFocusOut(event: FocusEvent) {
		const row = event.currentTarget as HTMLElement;
		const next = event.relatedTarget as Node | null;
		if (!next || row.contains(next)) return;
		if (!(next instanceof Element) || !next.closest(".list-item") || !listEl?.contains(next)) return;
		const art = rowArticle(row);
		if (art && !art.matches(":hover")) art.dispatchEvent(new PointerEvent("pointerleave"));
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
				item={rows[currentDragId]}
				idx={currentDragId}
			/>
		</div>
	{/if}
	{#each rows as item, index (item)}
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
			on:focusin={onRowFocusIn}
			on:focusout={onRowFocusOut}
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
				<!-- Reorder grip, visible at rest (audit v4 TOP 9). Decorative for
				     assistive tech: reordering stays a pointer gesture. -->
				<span
					class="drag-handle"
					aria-hidden="true"
					draggable="true"
					title="Glisser pour déplacer"
				/>
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
	// Reorder grip in the row's left padding (desktop rows pad 2.25em). Muted
	// at rest, full on hover / keyboard focus, stronger on touch screens that
	// have no hover at all. Phones (< 720px) keep long press + the kebab
	// ListItem already shows there, and their 1em padding has no room.
	.drag-handle {
		position: absolute;
		z-index: 2;
		left: 0.45em;
		top: 50%;
		width: 0.9em;
		height: 1.6em;
		transform: translateY(-50%);
		cursor: grab;
		touch-action: none;
		opacity: 0.35;
		transition: opacity 150ms linear;
		background: radial-gradient(circle, hsla(0, 0%, 100%, 0.9) 1.5px, transparent 2px) 0 0 /
			50% 33.333% repeat;
		@media (hover: none) {
			opacity: 0.7;
		}
		@media screen and (max-width: 719px) {
			display: none;
		}
	}
	.list-item:hover .drag-handle,
	.list-item:focus-within .drag-handle {
		opacity: 1;
	}
	// "En cours" (11px, muted) under the playing marker of the current row:
	// below the play triangle of the index column (desktop, or phone rows
	// without artwork), across the bottom of the artwork otherwise. Higher
	// specificity than ListItem's touch play badge (`.isPlaying
	// .thumbnail::after { display:none }`), which this replaces on that row.
	.list .list-item :global(.m-item.isPlaying .index) {
		position: relative;
	}
	.list .list-item :global(.m-item.isPlaying .index::after) {
		content: "En cours";
		position: absolute;
		left: 50%;
		top: calc(50% + 0.85em);
		transform: translateX(-50%);
		font-size: 11px;
		line-height: 1.2;
		font-weight: 500;
		white-space: nowrap;
		color: hsla(0, 0%, 100%, 0.62);
	}
	.list .list-item :global(.m-item.isPlaying .thumbnail::after) {
		content: "En cours";
		display: block;
		position: absolute;
		inset: auto 0 0 0;
		margin: 0;
		width: auto;
		height: auto;
		padding: 1px 0 2px;
		border-radius: 0 0 var(--xs-radius) var(--xs-radius);
		box-shadow: none;
		background: rgba(0, 0, 0, 0.62);
		font-size: 11px;
		line-height: 1.2;
		font-weight: 500;
		text-align: center;
		white-space: nowrap;
		color: hsla(0, 0%, 100%, 0.8);
		pointer-events: none;
	}
	@media screen and (min-width: 720px) {
		// desktop: the label sits under the triangle, not on the artwork
		.list .list-item :global(.m-item.isPlaying .index ~ .metadata .thumbnail::after) {
			content: none;
			display: none;
		}
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
