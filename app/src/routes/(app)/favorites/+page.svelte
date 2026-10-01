<script lang="ts">
	// F10: /favorites and /library/saved were two favourites pages. This one
	// read the IndexedDB copy only; /library/saved reads the profile's
	// me/favorites (and falls back to the same IndexedDB copy offline), so it
	// is the one page. Kept as a client redirect for bookmarks, the ♥ of the
	// navigation bar and the service-worker shell list (like /downloads -> /).
	import { browser } from "$app/environment";
	import { goto } from "$app/navigation";
	if (browser) goto("/library/saved", { replaceState: true });
</script>
