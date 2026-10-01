import { beforeEach, describe, expect, it, vi } from "vitest";

// F11: a group session must be re-initialisable after disconnect(). The
// class is exercised with its heavy neighbours (PeerJS, player, session
// list) stubbed out.
const list = vi.hoisted(() => ({
	next: vi.fn(async () => {}),
	toJSON: () => "{}",
	set: vi.fn(),
	lockedSet: vi.fn(),
	updatePosition: vi.fn(),
	initAutoMixSession: vi.fn(),
	initPlaylistSession: vi.fn(),
	prefetchTrackAtIndex: vi.fn(),
	previous: vi.fn(),
	setTrackWillPlayNext: vi.fn(async () => true),
	subscribe: (run: (v: unknown) => void) => (run({ mix: [], position: 0 }), () => {}),
}));
vi.mock("$app/environment", () => ({ browser: true, dev: false }));
vi.mock("./list/", () => ({ default: list }));
vi.mock("$lib/player", () => ({ AudioPlayer: { play: vi.fn(), updateSrc: vi.fn() }, getSrc: vi.fn() }));
vi.mock("$lib/utils/utils", () => ({ notify: vi.fn() }));
vi.mock("peerjs", () => ({
	default: class PeerStub {
		connections = {};
		on() {
			/* no signalling in tests */
		}
		connect() {
			return { peer: "x", on() {}, close() {}, send() {} };
		}
		destroy() {}
	},
}));

import { GroupSession } from "./sessions";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("F11: group session re-init after disconnect", () => {
	beforeEach(() => list.next.mockClear());

	it("init -> disconnect -> init gives a clean, active session", async () => {
		const gs = new GroupSession();
		gs.init("Alice", "host");
		await settle();
		expect(gs.initialized).toBe(true);
		expect(gs.hasActiveSession).toBe(true);
		expect(gs.type).toBe("host");
		const firstId = gs.client.clientId;

		gs.disconnect();
		expect(gs.initialized).toBe(false);
		expect(gs.hasActiveSession).toBe(false);
		expect(gs.connections).toEqual([]);
		expect(gs.connection).toBeUndefined();

		gs.init("Bob", "guest");
		await settle();
		expect(gs.initialized).toBe(true);
		expect(gs.hasActiveSession).toBe(true);
		expect(gs.type).toBe("guest");
		expect(gs.client.displayName).toBe("Bob");
		expect(gs.client.clientId).not.toBe(firstId);
		expect(gs.connections).toEqual([]);
		expect(() => gs.disconnect()).not.toThrow();
	});

	it("the all-can-play watcher is alive again after a re-init (it drove next())", async () => {
		const gs = new GroupSession();
		gs.init("Alice", "host");
		await settle();
		gs.disconnect();
		gs.init("Alice", "host");
		await settle();
		// Every connected client (here: just the host) reports finished: the
		// host advances the queue. Before the fix the watcher had been
		// unsubscribed for good by the first disconnect().
		gs.sendGroupState({ client: gs.client.clientId, state: { finished: true } });
		expect(list.next).toHaveBeenCalledTimes(1);
		gs.disconnect();
	});

	it("disconnect() twice and before any init never throws", () => {
		const gs = new GroupSession();
		expect(() => gs.disconnect()).not.toThrow();
		expect(() => gs.disconnect()).not.toThrow();
		expect(gs.hasActiveSession).toBe(false);
	});
});
