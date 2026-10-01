// L10-9: one more attempt after `delayMs` when `fn` rejects (home.json: a
// YouTube hiccup or a cold MISS timing out should not leave the home without
// its YouTube rows). The second failure is the caller's to show.
export async function retryOnce<T>(
	fn: () => Promise<T>,
	delayMs = 2000,
	wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
	try {
		return await fn();
	} catch {
		await wait(delayMs);
		return fn();
	}
}
