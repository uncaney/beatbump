// Move a node to <body> (or another target) so a fixed-position dialog is not
// trapped by an ancestor that is a containing block (`contain: layout` on the
// player footer, `contain: strict` on the fullscreen backdrop).
export function portal(
	node: HTMLElement,
	target: HTMLElement | string = "body",
): SvelteActionReturnType {
	const el =
		typeof target === "string"
			? (document.querySelector(target) as HTMLElement | null)
			: target;
	if (el) el.appendChild(node);
	return {
		destroy() {
			if (node.parentNode) node.parentNode.removeChild(node);
		},
	};
}

export default portal;
