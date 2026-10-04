<script lang="ts">
	export let value: number;
	export let options: { params: string; action: () => void; label: string }[] =
		[];
</script>

<label
	class="secondary"
	for="select">Trier</label
>

<div class="select">
	<select
		id="select"
		bind:value
		on:change
	>
		{#each options as option, i (option.params)}
			<option
				value={i}
				selected={value === i}>{option.label}</option
			>
		{/each}
	</select>
</div>

<style lang="scss">
	@import "./index.scss";

	/* U11-6 (audit UX v11): 44px tap height for the sort select (the global
	   .select wrapper's 5ch min-height is ~33px at the 12px mobile root). */
	.select {
		min-height: max(2.75rem, 44px);
	}
</style>
