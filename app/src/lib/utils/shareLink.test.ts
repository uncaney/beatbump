import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/utils", () => ({ notify: vi.fn() }));

import { canonicalShareURL, shareLink } from "./shareLink";

describe("canonicalShareURL", () => {
	it("tracks share /listen?id=, albums /release?id=", () => {
		expect(canonicalShareURL("track", "dQw4w9WgXcQ", "https://music.ekaii.fr")).toBe("https://music.ekaii.fr/listen?id=dQw4w9WgXcQ");
		expect(canonicalShareURL("album", "lb-0123456789ab", "https://music.ekaii.fr/")).toBe("https://music.ekaii.fr/release?id=lb-0123456789ab");
		expect(canonicalShareURL("album", "lb-0123.a+b/c=", "https://x")).toBe("https://x/release?id=lb-0123.a%2Bb%2Fc%3D");
	});
});

describe("shareLink", () => {
	const data = { title: "T", url: "https://x/listen?id=a" };
	it("uses the Web Share sheet when available", async () => {
		const toast = vi.fn();
		const share = vi.fn().mockResolvedValue(undefined);
		const writeText = vi.fn();
		const out = await shareLink(data, { share, canShare: () => true, clipboard: { writeText } } as any, toast);
		expect(out).toBe("shared");
		expect(share).toHaveBeenCalledWith(data);
		expect(writeText).not.toHaveBeenCalled();
		expect(toast).not.toHaveBeenCalled();
	});
	it("copies the URL with a 'Lien copié' toast without Web Share", async () => {
		const toast = vi.fn();
		const writeText = vi.fn().mockResolvedValue(undefined);
		const out = await shareLink(data, { clipboard: { writeText } } as any, toast);
		expect(out).toBe("copied");
		expect(writeText).toHaveBeenCalledWith("https://x/listen?id=a");
		expect(toast).toHaveBeenCalledWith("Lien copié", "success");
	});
	it("a dismissed sheet is silent, a failed share falls back to the clipboard", async () => {
		const toast = vi.fn();
		const writeText = vi.fn().mockResolvedValue(undefined);
		const abort = Object.assign(new Error("x"), { name: "AbortError" });
		expect(await shareLink(data, { share: vi.fn().mockRejectedValue(abort), clipboard: { writeText } } as any, toast)).toBe("cancelled");
		expect(writeText).not.toHaveBeenCalled();
		const denied = Object.assign(new Error("x"), { name: "NotAllowedError" });
		expect(await shareLink(data, { share: vi.fn().mockRejectedValue(denied), clipboard: { writeText } } as any, toast)).toBe("copied");
		expect(toast).toHaveBeenCalledWith("Lien copié", "success");
	});
	it("reports a failure when nothing works", async () => {
		const toast = vi.fn();
		expect(await shareLink(data, {} as any, toast)).toBe("failed");
		expect(toast).toHaveBeenCalledWith("Impossible de copier le lien", "error");
	});
});
