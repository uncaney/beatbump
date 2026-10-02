import { describe, expect, it } from "vitest";
import { liveRouteKey } from "./routeKey";

describe("liveRouteKey", () => {
	it("prefers the live location pathname (set before the slot swap) over the lagging page store key", () => {
		expect(liveRouteKey("/search/daft%20punk", { pathname: "/library/account" })).toBe("/library/account");
	});

	it("falls back to the prop without a location (SSR, tests) or with an unusable pathname", () => {
		expect(liveRouteKey("/home", null)).toBe("/home");
		expect(liveRouteKey("/home", undefined)).toBe("/home");
		expect(liveRouteKey("/home", { pathname: "" })).toBe("/home");
		expect(liveRouteKey("/home", { pathname: 42 })).toBe("/home");
	});
});
