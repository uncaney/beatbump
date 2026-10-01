import { describe, expect, it } from "vitest";
import { slimLastTrack } from "./resumeState";
import { readLastTrack } from "$lib/homeRows";

describe("PF3-12: slimLastTrack", () => {
	const track = {
		videoId: "dQw4w9WgXcQ",
		title: "Never Gonna Give You Up",
		playlistId: "RDAMVMdQw4w9WgXcQ",
		autoMixList: "RDAMVMdQw4w9WgXcQ",
		playerParams: "8AUB",
		localUrl: "/localf?lid=abc",
		thumbnails: [
			{ url: "https://i/w60", width: 60, height: 60 },
			{ url: "https://i/w120", width: 120, height: 120 },
			{ url: "https://i/w544", width: 544, height: 544 },
		],
		artistInfo: { artist: [{ text: "Rick Astley", browseId: "UC1" }] },
		loggingContext: { vssLoggingContext: { serializedContextData: "z".repeat(2000) } },
		clickTrackingParams: "c".repeat(300),
		menu: { menuRenderer: { items: new Array(20).fill({ x: "y".repeat(50) }) } },
	};

	it("keeps what the resume paths read, one (first) thumbnail, no tracking", () => {
		const s = slimLastTrack(track)!;
		expect(s.videoId).toBe(track.videoId);
		expect(s.playlistId).toBe(track.playlistId);
		expect(s.autoMixList).toBe(track.autoMixList);
		expect(s.playerParams).toBe("8AUB");
		expect(s.localUrl).toBe(track.localUrl);
		expect(s.thumbnails).toEqual([{ url: "https://i/w60", width: 60, height: 60 }]);
		expect(s.artistInfo.artist[0].text).toBe("Rick Astley");
		expect(s).not.toHaveProperty("loggingContext");
		expect(s).not.toHaveProperty("clickTrackingParams");
		expect(s).not.toHaveProperty("menu");
		const raw = JSON.stringify(s);
		expect(raw.length).toBeLessThan(600);
		expect(JSON.stringify(track).length).toBeGreaterThan(3000);
	});

	it("round-trips through readLastTrack (the Reprendre row)", () => {
		const raw = JSON.stringify(slimLastTrack(track));
		const back = readLastTrack({ getItem: () => raw });
		expect(back?.videoId).toBe(track.videoId);
		expect(back?.title).toBe(track.title);
	});

	it("returns null for a row without videoId", () => {
		expect(slimLastTrack({ title: "x" })).toBeNull();
		expect(slimLastTrack(null)).toBeNull();
	});
});
