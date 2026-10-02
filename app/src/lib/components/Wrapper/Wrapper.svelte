<svelte:options immutable={true} />

<script
	context="module"
	lang="ts"
>
</script>

<script lang="ts">
	import { scrollObserver } from "$lib/actions/scrollObserver";
	import { beforeUpdate, createEventDispatcher } from "svelte";

	import { cubicOut } from "svelte/easing";
	import { fly } from "svelte/transition";
	import { liveRouteKey } from "./routeKey";
	export let main: HTMLElement;
	export let key: string;
	// c48c (BACKLOG P2, login_keeps_inflight_writes): `key` ($page.url.pathname)
	// changes one flush AFTER SvelteKit swapped the page into the slot (the
	// page store notifies in Root's afterUpdate), so keying on it recreated
	// every page a second time right after its first mount; the first instance
	// lingered 150 ms in the outro and a form filled meanwhile (the Compte
	// login name, while a play started) was wiped. The live location, pushed
	// BEFORE the swap, is read in beforeUpdate: the key moves in the same
	// flush as the slot, the page mounts once. `key` stays the fallback.
	const location_ = () => (typeof location === "undefined" ? null : location);
	let routeKey = liveRouteKey(key, location_());
	beforeUpdate(() => {
		routeKey = liveRouteKey(key, location_());
	});
	// When false (error page), the content is keyed in without any fade: the
	// 404 used to be captured mid-transition at 19 % opacity.
	// K1 (audit perf v2): 0 ms delay + 150 ms fade (was 500 + 500: every page
	// waited half a second before appearing, then faded for another half).
	export let animate = true;
	const DURATION = 150;

	const dispatch = createEventDispatcher<{ scrolled: boolean }>();
</script>

<div
	class="app-content-p"
	bind:this={main}
	on:scrolled={({ detail }) => dispatch("scrolled", detail["isIntersecting"])}
	use:scrollObserver={{ target: ".scroll-target" }}
>
	<div class="scroll-target" />
	{#key routeKey}
		<div
			class="app-transition-wrapper"
			in:fly={{
				x: -5,
				duration: animate ? DURATION : 0,
				delay: 0,
				easing: cubicOut,
			}}
			out:fly={{
				x: -5,
				duration: animate ? DURATION : 0,
				easing: cubicOut,
				opacity: 0,
			}}
		>
			<slot />
		</div>
	{/key}
</div>

<style>
	.scroll-target {
		position: absolute;
		top: 2.25rem;
		left: 0;
		right: 0;
		height: 1px;
	}
	.app-transition-wrapper {
		transform: translateZ(0);
		will-change: top;
		isolation: isolate;
		padding-bottom: 2.1rem;
	}

	.app-content-p {
		/* display: grid;
        */
		inset: 0;
		position: absolute;
	}
</style>
