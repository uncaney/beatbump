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
	import { createEventDispatcher, onMount, tick } from "svelte";
	import { SWIPE_ENGAGE, holdDelay, idleMove, keyTarget, moveIndex, swallowClick } from "./dragGesture";

	// eslint-disable-next-line no-undef
	export let items: T[] = [];
	export let style = "";
	/** Touch: swipe a row left to reveal "Retirer" (dispatches `remove`). */
	export let swipeToRemove = false;
	/** Row that can never be swiped away (the playing track). */
	export let lockedIndex: number | null = null;

	const dispatch = createEventDispatcher<{
		click: void;
		dragstart: { event: PointerEvent | KeyboardEvent; index: number };
		dragend: { event: PointerEvent | KeyboardEvent; index: number };
		dragover: { event: PointerEvent; index: number };
		remove: { index: number; item: T };
	}>();

	let isDragging = false;
	let currentDragId: number | null = null;
	let dragY = 0;
	// Ghost offset: centred on the pointer (half a row).
	let ghostOffset = "0px";
	// The playing track when a drag starts (lists other than the queue): after
	// the in-place moves the cursor (position) must follow it, else the
	// highlight and next() point at the wrong row once a row crosses the
	// current one.
	let dragCurrentTrack: T | null = null;
	// True while the queue itself is being dragged (`items` is the session
	// mix). The moves then happen on a private copy and the queue is replaced
	// once, on drop, through SessionListService.reorder(): the store setter
	// runs (subscribers, tab sync) and the warm next-track URL is refreshed, so
	// "suivant" plays the new neighbour (G1). Before, the shared array was
	// swapped in place and no subscriber ever heard of it.
	let queueDrag = false;
	// Queue drag (H4): the parent re-pushes `items` (= the store mix) on every
	// store emission (track change, continuation), so the moves live in
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
		// I17: outside the queue (favorites, playlist page) the rows are not the
		// queue: never move its cursor from a row index (the playlist page
		// reorders the playing queue itself, by videoId).
		dragCurrentTrack = queueDrag ? ((s.mix[s.position] as T) ?? null) : null;
	};
	/** Move one row (a single move, never a swap across several rows). */
	const moveRow = (from: number, to: number) => {
		if (queueDrag) {
			dragItems = moveIndex(dragItems, from, to);
		} else {
			// Other lists (favorites, playlists) are reordered in place, as
			// they always were: the parent owns the array.
			const next = moveIndex(items, from, to);
			items.splice(0, items.length, ...next);
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

	// A parent handler written for the old native drag (it reads
	// `event.dataTransfer`) must not break the gesture: it is isolated.
	const emitDragStart = (event: PointerEvent | KeyboardEvent, index: number) => {
		try {
			dispatch("dragstart", { event, index });
		} catch (err) {
			console.warn("[list] dragstart handler failed", err);
		}
	};

	const finishDrag = () => {
		currentDragId = null;
		isDragging = false;
	};

	// ---------------- Pointer Events: mouse, pen and touch ----------------
	// One mechanism for every pointer (c19a). Native HTML5 drag and drop is
	// cancelled on `dragstart`: it used to compete with this path (the grip
	// was `draggable`, the mouse path waited 250 ms after `dragstart` before
	// arming, so a quick drag ended as a "click" and nothing moved).
	//  - grip (.drag-handle): the drag starts on pointerdown;
	//  - row, mouse / pen: after a 250 ms hold or 6 px of travel;
	//  - row, touch: long press (250 ms, no travel); a leftward horizontal
	//    travel of 24 px is a swipe to remove; anything else is left to the
	//    browser (vertical scroll, `touch-action: pan-y`, then pointercancel).
	const SWIPE_OPEN = 96;
	// The click that follows a drag release is swallowed during this window.
	const CLICK_SWALLOW_MS = 400;

	type PressMode = "idle" | "drag" | "swipe" | "cancel";
	let listEl: HTMLDivElement;
	let touch: {
		index: number;
		x: number;
		y: number;
		pointerId: number;
		pointerType: string;
		fromHandle: boolean;
		moved: boolean;
		el: HTMLElement;
		mode: PressMode;
		timer?: ReturnType<typeof setTimeout>;
	} | null = null;
	let lastPointerType = "";
	let swipeIndex: number | null = null;
	let swipeX = 0;
	let openIndex: number | null = null;
	let suppressClickUntil = 0;

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

	// A drag release must not play the row under the pointer: with pointer
	// capture (or a release over another row) the click can land on any
	// ancestor, so it is swallowed at the window, capture phase.
	onMount(() => {
		const swallow = (event: MouseEvent) => {
			if (!suppressClickUntil) return;
			const live = performance.now() < suppressClickUntil;
			suppressClickUntil = 0;
			if (!live) return;
			event.stopPropagation();
			event.preventDefault();
		};
		window.addEventListener("click", swallow, true);
		return () => window.removeEventListener("click", swallow, true);
	});

	function startDrag(event: PointerEvent) {
		if (!touch) return;
		if (touch.timer) clearTimeout(touch.timer);
		const { el, index, pointerId } = touch;
		touch.mode = "drag";
		touch = touch;
		try {
			el.setPointerCapture(pointerId);
		} catch {
			/* already captured or gone */
		}
		currentDragId = index;
		ghostOffset = `${Math.round(el.offsetHeight / 2)}px`;
		updateGhostY(event.clientY);
		captureCurrent(index);
		isDragging = true;
		if (touch.pointerType === "touch") {
			try {
				navigator.vibrate?.(10);
			} catch {
				/* no haptics */
			}
		}
		emitDragStart(event, index);
	}

	function onPointerDown(event: PointerEvent, index: number) {
		lastPointerType = event.pointerType;
		// mouse: main button only (a right click opens the context menu)
		if (event.pointerType !== "touch" && event.button !== 0) return;
		if (openIndex !== null && openIndex !== index) openIndex = null;
		const el = event.currentTarget as HTMLElement;
		// The visible grip (.drag-handle, touch-action none) starts the drag at
		// once; anywhere else on the row needs the hold (or, mouse, travel).
		const fromHandle = !!(event.target as Element | null)?.closest?.(".drag-handle");
		if (touch?.timer) clearTimeout(touch.timer);
		touch = {
			index,
			x: event.clientX,
			y: event.clientY,
			pointerId: event.pointerId,
			pointerType: event.pointerType,
			fromHandle,
			moved: false,
			el,
			mode: "idle",
		};
		const delay = holdDelay(fromHandle);
		if (delay === 0) {
			startDrag(event);
			return;
		}
		touch.timer = setTimeout(() => {
			if (!touch || touch.mode !== "idle") return;
			startDrag(event);
		}, delay);
	}

	function onMouseDown(event: MouseEvent) {
		// A grip press is ours: no text selection, no native drag, no focus jump.
		if (touch?.fromHandle && touch.mode === "drag") event.preventDefault();
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

	// Keyboard reorder: Alt+ArrowUp / Alt+ArrowDown moves the focused row.
	async function onRowKeyDown(event: KeyboardEvent, index: number) {
		if (!event.altKey || event.ctrlKey || event.metaKey || touch) return;
		const to = keyTarget(event.key, index, rows.length);
		if (to === null) return;
		event.preventDefault();
		event.stopPropagation();
		captureCurrent(index);
		emitDragStart(event, index);
		moveRow(index, to);
		syncCursor();
		dispatch("dragend", { event, index: to });
		await tick();
		listEl?.querySelector<HTMLElement>(`[data-index="${to}"] .m-item`)?.focus();
	}

	function onPointerMove(event: PointerEvent) {
		if (!touch || event.pointerId !== touch.pointerId) return;
		const dx = event.clientX - touch.x;
		const dy = event.clientY - touch.y;
		if (touch.mode === "idle") {
			const canSwipe = swipeToRemove && touch.index !== lockedIndex;
			const outcome = idleMove(touch.pointerType, dx, dy, canSwipe);
			if (outcome === "none") return;
			if (outcome === "cancel") {
				if (touch.timer) clearTimeout(touch.timer);
				touch.mode = "cancel";
				touch = touch;
				return;
			}
			if (outcome === "swipe") {
				if (touch.timer) clearTimeout(touch.timer);
				touch.mode = "swipe";
				touch = touch;
				swipeIndex = touch.index;
				try {
					touch.el.setPointerCapture(event.pointerId);
				} catch {
					/* ignore */
				}
			} else {
				startDrag(event);
			}
		}
		if (touch.mode === "swipe") {
			swipeX = Math.min(0, dx);
			return;
		}
		if (touch.mode === "drag") {
			updateGhostY(event.clientY);
			const over = rowIndexAt(event.clientX, event.clientY);
			if (over !== null && currentDragId !== null && over !== currentDragId) {
				moveRow(currentDragId, over);
				currentDragId = over;
				touch.moved = true;
				dispatch("dragover", { event, index: over });
			}
		}
	}

	function onPointerUp(event: PointerEvent) {
		if (!touch || event.pointerId !== touch.pointerId) return;
		if (touch.timer) clearTimeout(touch.timer);
		const { mode, index, el, pointerType, fromHandle, moved } = touch;
		touch = null;
		if (mode === "drag") {
			if (swallowClick(pointerType, fromHandle, moved)) {
				suppressClickUntil = performance.now() + CLICK_SWALLOW_MS;
			}
			const at = currentDragId as number;
			syncCursor();
			dispatch("dragend", { event, index: at });
			finishDrag();
		} else if (mode === "swipe") {
			suppressClickUntil = performance.now() + CLICK_SWALLOW_MS;
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
			// already moved consistent, same as a drop would.
			const at = currentDragId as number;
			syncCursor();
			dispatch("dragend", { event, index: at });
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

<!-- Moves and releases are followed at the window: the rows are re-ordered
     (DOM nodes moved) during the drag, which can drop the pointer capture
     of the pressed row; every pointer event still bubbles up here. -->
<svelte:window
	on:pointermove={onPointerMove}
	on:pointerup={onPointerUp}
	on:pointercancel={onPointerCancel}
/>

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
			on:mousedown={onMouseDown}
			on:keydown={(event) => onRowKeyDown(event, index)}
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
			on:dragstart={(event) => {
				// Reordering is pointer events only: a `draggable` row (ListItem)
				// must never start a native drag, which would fire pointercancel
				// and end the pointer drag.
				event.preventDefault();
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
				     assistive tech: keyboard users reorder with Alt+ArrowUp/Down. -->
				<span
					class="drag-handle"
					aria-hidden="true"
					title="Glisser pour déplacer (Alt+↑/↓ au clavier)"
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
