<script lang="ts">
	// p17-frontend: concept3 server-side download queue removed.
	// Kept as a redirect so any stale bookmark/deep-link lands on home.
	import { browser } from "$app/environment";
	import { goto } from "$app/navigation";
	if (browser) goto("/", { replaceState: true });
</script>
